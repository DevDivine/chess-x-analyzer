/* ============================================================
   ChessIQ — Chess Game Analyzer (v2, expected-points model)
   Requirements:
   - Load chess.js before this script (v0.x or v1.x both work).
   - Stockfish worker: ./stockfish-19-lite-single.js
   - Page IDs: input, format, analyze-btn, status, results
   - Optional page IDs: depth (a <select> of search depths)

   What changed vs v1 (why results were far from Chess.com):
   1. Moves are graded by EXPECTED POINTS lost (win-probability),
      not raw pawn loss. A 1-pawn drop at +8 is nothing; at 0.0 it is
      a lot. This is the model Chess.com's Game Review describes.
   2. Win-probability is rating-aware (PGN WhiteElo/BlackElo).
   3. Stockfish runs MultiPV 3. The played move's score is read from
      the SAME search as the best move whenever it is in the top
      lines, which removes depth-mismatch noise (fake "inaccuracies").
   4. Checkmate / stalemate positions are scored exactly. (v1 treated
      "mate 0" as 0.00, so delivering mate could be graded a mistake.)
   5. New labels: Great, Good, Miss, Forced, plus a real sacrifice
      detector for Brilliant (material is checked along the engine PV).
   6. Book detection uses positions (handles transpositions) and a
      much larger opening list.
   7. Accuracy uses the open Lichess formula: per-move accuracy from
      win% loss, combined by volatility-weighted + harmonic mean.
   8. Searches that hit the time limit return their best result so
      far instead of failing the whole analysis. Default depth 16.

   NOTE: Chess.com's exact formulas (accuracy "CAPS", Brilliant/Great
   rules, rating curves) are proprietary. This matches the published
   model closely, but tiny differences are expected. Tune the CONFIG
   block below to calibrate.
   ============================================================ */
(() => {
  "use strict";

  // ---------------- CONFIG (tune here) ----------------
  const STOCKFISH_WORKER_PATH = "./stockfish-19-lite-single.js";
  const DEFAULT_DEPTH = 14;        // overridden by <select id="depth"> if present
  const FEN_DEPTH = 20;
  const MULTIPV = 2;            // 2 is enough for Great/gap detection; 3 is ~30% slower
  const INIT_TIMEOUT_MS = 30000;
  // Per-position time cap (ms), chosen from depth. Engine stops at depth OR time, whichever first.
  function movetimeFor(depth) {
    if (depth >= 20) return 12000;
    if (depth >= 18) return 8000;
    if (depth >= 16) return 4000;
    return 2000;
  }
  const SEARCH_WATCHDOG_MS = 20000; // if the engine is silent this long, restart it
  const DEFAULT_RATING = 1500;     // used when PGN has no Elo

  // Expected-points loss cutoffs (win-probability lost, 0..1).
  const EP_THRESHOLDS = {
    best: 0.005,
    excellent: 0.02,
    good: 0.05,
    inaccuracy: 0.10,
    mistake: 0.20          // above this = blunder
  };

  const GREAT_GAP = 0.12;            // best move beats 2nd-best line by this much
  const GREAT_MAX_ALREADY_WON = 0.95;
  const BRILLIANT_MIN_SACRIFICE = 2; // pawns of net material given up along the PV
  const BRILLIANT_MAX_LOSS = 0.02;
  const BRILLIANT_MIN_EP_AFTER = 0.45;
  const BRILLIANT_MAX_EP_BEFORE = 0.90;
  const MISS_MIN_OPPORTUNITY = 0.65; // best move would have given at least this
  const MISS_MIN_EP_AFTER = 0.35;    // ...and you didn't just throw the game
  const MISS_MIN_LOSS = 0.10;
  const MISS_OPP_MIN_LOSS = 0.10;    // opponent's previous move was at least this bad

  // ---------------- DOM ----------------
  const inputEl = document.getElementById("input");
  const formatEl = document.getElementById("format");
  const btnEl = document.getElementById("analyze-btn");
  const statusEl = document.getElementById("status");
  const resultsEl = document.getElementById("results");

  if (!inputEl || !btnEl || !statusEl || !resultsEl) {
    console.error("ChessIQ analyzer: required page elements are missing.");
    return;
  }

  if (typeof window.Chess !== "function") {
    statusEl.textContent =
      "Error: chess.js was not loaded before the analyzer script.";
    return;
  }

  (function injectStyles() {
    if (document.getElementById("chessiq-extra-styles")) return;
    const style = document.createElement("style");
    style.id = "chessiq-extra-styles";
    style.textContent =
      ".move.great,.cat-great{color:#5c8bb0}" +
      ".move.good,.cat-good{color:#81b64c}" +
      ".move.miss,.cat-miss{color:#ee6b55}" +
      ".move.forced,.cat-forced{color:#9a9a9a}";
    document.head.appendChild(style);
  })();

  // ---------------- chess.js compatibility (v0.x and v1.x) ----------------
  function callFirst(obj, names, ...args) {
    for (const name of names) {
      if (typeof obj[name] === "function") return obj[name](...args);
    }
    throw new Error("Unsupported chess.js version (missing " + names[0] + ").");
  }

  const isCheckmate = c => callFirst(c, ["isCheckmate", "in_checkmate"]);
  const isDraw = c => callFirst(c, ["isDraw", "in_draw"]);

  function safeMove(chess, uci) {
    try {
      const result = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined
      });
      return result || null;
    } catch (_) {
      return null;
    }
  }

  function loadPgnCompat(chess, text) {
    const names = ["loadPgn", "load_pgn"];
    for (const name of names) {
      if (typeof chess[name] === "function") {
        const result = chess[name](text, { sloppy: true });
        if (result === false) throw new Error("Invalid PGN or no legal moves found.");
        return;
      }
    }
    throw new Error("Unsupported chess.js version (no PGN loader).");
  }

  function positionKey(fen) {
    // placement + side to move + castling (en-passant field differs between versions)
    return fen.split(" ").slice(0, 3).join(" ");
  }

  // ---------------- Format detection ----------------
  function looksLikeFen(text) {
    const fields = text.trim().split(/\s+/);
    if (fields.length < 4 || fields.length > 6) return false;
    const ranks = fields[0].split("/");
    if (ranks.length !== 8) return false;
    const validPieces = /^[prnbqkPRNBQK1-8]+$/;
    if (!ranks.every(rank => validPieces.test(rank))) return false;
    if (!["w", "b"].includes(fields[1])) return false;
    return /^[KQkq-]+$/.test(fields[2]) && /^[a-h1-8-]+$/.test(fields[3]);
  }

  function looksLikePgn(text) {
    return (
      /^\s*\[Event\s+"/im.test(text) ||
      /^\s*\[[A-Za-z]+\s+"/m.test(text) ||
      /\b1\.\s*(?:O-O-O|O-O|[KQRBN]?[a-h1-8x=+#-])/m.test(text) ||
      /\b1\.\.\.\s*(?:O-O-O|O-O|[KQRBN]?[a-h1-8x=+#-])/m.test(text)
    );
  }

  function detectFormat(text) {
    if (looksLikeFen(text)) return "FEN";
    if (looksLikePgn(text)) return "PGN";
    return "UNKNOWN";
  }

  if (formatEl) {
    inputEl.addEventListener("input", () => {
      const text = inputEl.value.trim();
      formatEl.textContent = text ? "Format: " + detectFormat(text) : "Format: —";
    });
  }

  // ---------------- Stockfish UCI worker ----------------
  let worker = null;
  let engineReady = false;
  let engineFailed = false;
  let initPromise = null;
  let activeSearch = null;
  let commandQueue = Promise.resolve();

  function terminateEngine() {
    if (worker) {
      try { worker.terminate(); } catch (_) {}
    }
    worker = null;
    engineReady = false;
    activeSearch = null;
  }

  function sendCommand(command) {
    if (!worker) throw new Error("Stockfish worker is unavailable.");
    worker.postMessage(command);
  }

  function parseInfoLine(line) {
    if (!line.startsWith("info ")) return null;
    if (/\b(lowerbound|upperbound)\b/.test(line)) return null;

    const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
    const depthMatch = line.match(/\bdepth (\d+)/);
    const pvMatch = line.match(/\bpv\s+(.+)$/);
    if (!scoreMatch || !depthMatch || !pvMatch) return null;

    const multipvMatch = line.match(/\bmultipv (\d+)/);
    const pv = pvMatch[1].trim().split(/\s+/);

    return {
      index: multipvMatch ? Number(multipvMatch[1]) : 1,
      depth: Number(depthMatch[1]),
      cp: scoreMatch[1] === "cp" ? Number(scoreMatch[2]) : null,
      mate: scoreMatch[1] === "mate" ? Number(scoreMatch[2]) : null,
      move: pv[0],
      pv
    };
  }

  function finishSearch(search) {
    const lines = Object.values(search.lines).sort((a, b) => a.index - b.index);
    if (!lines.length) {
      search.reject(new Error("Stockfish returned no evaluation."));
      return;
    }
    search.resolve({
      lines,
      depth: Math.max(...lines.map(l => l.depth)),
      source: "stockfish"
    });
  }

  function initEngine() {
    if (engineReady) return Promise.resolve();

    if (engineFailed) {
      return Promise.reject(new Error(
        "Stockfish could not start. Check that " + STOCKFISH_WORKER_PATH +
        " exists and is served over HTTP."
      ));
    }

    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
      let settled = false;
      let gotUciOk = false;
      let gotReadyOk = false;

      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        engineFailed = true;
        terminateEngine();
        reject(error);
      };

      const timer = setTimeout(
        () => fail(new Error("Stockfish initialization timed out.")),
        INIT_TIMEOUT_MS
      );

      function finishIfReady() {
        if (!settled && gotUciOk && gotReadyOk) {
          settled = true;
          clearTimeout(timer);
          engineReady = true;
          resolve();
        }
      }

      try {
        worker = new Worker(STOCKFISH_WORKER_PATH);
      } catch (error) {
        worker = null;
        fail(new Error(
          "Could not create Stockfish worker. Check its path and run the site through a server."
        ));
        return;
      }

      worker.onerror = event => {
        console.error("Stockfish worker error:", event);

        if (!settled) {
          fail(new Error("Stockfish worker failed to load."));
        } else if (activeSearch) {
          const search = activeSearch;
          activeSearch = null;
          search.reject(new Error("Stockfish crashed during analysis."));
        }
      };

      worker.onmessage = event => {
        const line = typeof event.data === "string"
          ? event.data
          : typeof event.data?.data === "string"
            ? event.data.data
            : "";

        if (!line) return;

        if (line === "uciok") {
          gotUciOk = true;
          try {
            sendCommand("setoption name Hash value 64");
            sendCommand("setoption name MultiPV value " + MULTIPV);
            sendCommand("isready");
          } catch (error) {
            fail(error);
          }
          return;
        }

        if (line === "readyok") {
          gotReadyOk = true;
          finishIfReady();
          return;
        }

        if (!activeSearch) return;
        const search = activeSearch;

        if (line.startsWith("info ")) {
          const info = parseInfoLine(line);
          if (info) {
            const existing = search.lines[info.index];
            if (!existing || info.depth >= existing.depth) {
              search.lines[info.index] = info;
            }
          }
          return;
        }

        if (line.startsWith("bestmove")) {
          activeSearch = null;
          finishSearch(search);
        }
      };

      try {
        sendCommand("uci");
      } catch (error) {
        fail(error);
      }
    });

    return initPromise;
  }

  function enqueueSearch(fen, depth) {
    const run = async () => {
      await initEngine();

      if (!worker || !engineReady) throw new Error("Stockfish is not ready.");
      if (activeSearch) throw new Error("Internal error: overlapping Stockfish searches.");

      return new Promise((resolve, reject) => {
        const search = {
          lines: {},
          timer: null,
          resolve: null,
          reject: null
        };

        search.resolve = value => { clearTimeout(search.timer); resolve(value); };
        search.reject = error => { clearTimeout(search.timer); reject(error); };

        activeSearch = search;

        // Watchdog. A single-threaded WASM engine cannot read "stop" mid-search,
        // so if it ever goes silent we throw the worker away (so a stale
        // "bestmove" can never leak into the next search) and start fresh.
        search.timer = setTimeout(() => {
          if (activeSearch !== search) return;
          activeSearch = null;

          const lines = Object.values(search.lines).sort((a, b) => a.index - b.index);

          terminateEngine();
          initPromise = null;
          engineFailed = false;

          if (lines.length) {
            resolve({
              lines,
              depth: Math.max(...lines.map(l => l.depth)),
              source: "stockfish"
            });
          } else {
            reject(new Error("Stockfish stopped responding on this position."));
          }
        }, SEARCH_WATCHDOG_MS);

        try {
          sendCommand("position fen " + fen);
          sendCommand("go depth " + depth + " movetime " + movetimeFor(depth));
        } catch (error) {
          activeSearch = null;
          search.reject(error);
        }
      });
    };

    const result = commandQueue.then(run, run);
    commandQueue = result.catch(() => {});
    return result;
  }

  // ---------------- Position evaluation (with terminal handling + cache) ----------------
  const evalCache = new Map();

  async function evaluatePosition(fen, depth) {
    const cacheKey = fen + "|" + depth;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey);

    const turn = fen.trim().split(/\s+/)[1];
    if (turn !== "w" && turn !== "b") {
      throw new Error("Invalid FEN: cannot determine side to move.");
    }

    const chess = new Chess(fen);
    let evaluation;

    if (isCheckmate(chess)) {
      evaluation = { fen, turn, terminal: "mate", lines: [], depth: 0 };
    } else if (isDraw(chess) || chess.moves().length === 0) {
      evaluation = { fen, turn, terminal: "draw", lines: [], depth: 0 };
    } else {
      const raw = await enqueueSearch(fen, depth);
      evaluation = {
        fen,
        turn,
        terminal: null,
        lines: raw.lines,
        depth: raw.depth,
        legalMoves: chess.moves().length
      };
    }

    evalCache.set(cacheKey, evaluation);
    return evaluation;
  }

  // ---------------- Expected points model ----------------
  // Win-probability from centipawns (Lichess-fitted logistic), with a
  // rating-dependent steepness: at lower ratings the same eval converts
  // less reliably, so the curve is flatter. The rating scaling is a
  // tunable approximation of Chess.com's rating-aware model.
  const BASE_K = 0.00368208;

  function ratingScale(rating) {
    const r = Number.isFinite(rating) ? rating : DEFAULT_RATING;
    const t = Math.max(0, Math.min(1, (r - 600) / (2300 - 600)));
    return 0.6 + 0.4 * t;
  }

  // Expected points (0..1) for the SIDE TO MOVE, given an engine line.
  function epSideToMove(evaluation, line, rating) {
    if (evaluation.terminal === "mate") return 0;
    if (evaluation.terminal === "draw") return 0.5;
    if (!line) throw new Error("Missing engine line.");

    if (line.mate !== null) return line.mate > 0 ? 1 : 0;

    const k = BASE_K * ratingScale(rating);
    return 1 / (1 + Math.exp(-k * line.cp));
  }

  // Expected points for a specific color.
  function epFor(evaluation, line, color, rating) {
    const ep = epSideToMove(evaluation, line, rating);
    return evaluation.turn === color ? ep : 1 - ep;
  }

  // Eval in pawns from White's point of view (for graph/display only).
  function whitePawns(evaluation) {
    if (evaluation.stub) return 0;
    let value;
    if (evaluation.terminal === "mate") value = -10;
    else if (evaluation.terminal === "draw") value = 0;
    else {
      const line = evaluation.lines[0];
      if (line.mate !== null) value = line.mate > 0 ? 10 : -10;
      else value = Math.max(-10, Math.min(10, line.cp / 100));
    }
    return evaluation.turn === "w" ? value : -value;
  }

  function formatEval(evaluation) {
    if (!evaluation) return "—";
    if (evaluation.stub) return "Book";
    if (evaluation.terminal === "mate") return "Checkmate";
    if (evaluation.terminal === "draw") return "Draw";

    const line = evaluation.lines[0];
    const sign = evaluation.turn === "w" ? 1 : -1;

    if (line.mate !== null) {
      const mate = line.mate * sign;
      return "#" + (mate > 0 ? "+" : "") + mate;
    }

    const score = (line.cp / 100) * sign;
    return (score > 0 ? "+" : "") + score.toFixed(2);
  }

  // ---------------- Helpers ----------------
  const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

  function materialBalance(fen, color) {
    const placement = fen.split(" ")[0];
    let mine = 0;
    let theirs = 0;
    for (const ch of placement) {
      const value = PIECE_VALUES[ch.toLowerCase()];
      if (!value) continue;
      const isWhitePiece = ch === ch.toUpperCase();
      if ((color === "w") === isWhitePiece) mine += value;
      else theirs += value;
    }
    return mine - theirs;
  }

  function moveToUci(move) {
    return move.from + move.to +
      (move.promotion ? String(move.promotion).toLowerCase() : "");
  }

  function uciToSan(fen, uci) {
    if (!uci) return null;
    try {
      const chess = new Chess(fen);
      const move = safeMove(chess, uci);
      return move ? move.san : uci;
    } catch (_) {
      return uci;
    }
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  // ---------------- Opening book (position-based, handles transpositions) ----------------
  const OPENINGS = [
    // 1.e4 e5
    { m: "e4 e5", n: "Open Game", eco: "C20" },
    { m: "e4 e5 Nf3", n: "King's Knight Opening", eco: "C40" },
    { m: "e4 e5 Nf3 Nc6", n: "King's Knight Opening: Normal Variation", eco: "C44" },
    { m: "e4 e5 Nf3 Nc6 Bb5", n: "Ruy López", eco: "C60" },
    { m: "e4 e5 Nf3 Nc6 Bb5 a6", n: "Ruy López: Morphy Defense", eco: "C70" },
    { m: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6", n: "Ruy López: Morphy Defense, Main Line", eco: "C78" },
    { m: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", n: "Ruy López: Closed", eco: "C84" },
    { m: "e4 e5 Nf3 Nc6 Bb5 Nf6", n: "Ruy López: Berlin Defense", eco: "C65" },
    { m: "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4", n: "Ruy López: Berlin Defense, Open", eco: "C67" },
    { m: "e4 e5 Nf3 Nc6 Bb5 f5", n: "Ruy López: Schliemann Defense", eco: "C63" },
    { m: "e4 e5 Nf3 Nc6 Bc4", n: "Italian Game", eco: "C50" },
    { m: "e4 e5 Nf3 Nc6 Bc4 Bc5", n: "Italian Game: Giuoco Piano", eco: "C53" },
    { m: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4", n: "Italian Game: Giuoco Piano, Main Line", eco: "C54" },
    { m: "e4 e5 Nf3 Nc6 Bc4 Bc5 b4", n: "Evans Gambit", eco: "C51" },
    { m: "e4 e5 Nf3 Nc6 Bc4 Nf6", n: "Italian Game: Two Knights Defense", eco: "C55" },
    { m: "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5", n: "Two Knights Defense: Knight Attack", eco: "C57" },
    { m: "e4 e5 Nf3 Nc6 Nc3 Nf6", n: "Four Knights Game", eco: "C47" },
    { m: "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5", n: "Four Knights Game: Spanish Variation", eco: "C48" },
    { m: "e4 e5 Nf3 Nc6 d4 exd4 Nxd4", n: "Scotch Game", eco: "C45" },
    { m: "e4 e5 Nf3 Nc6 d4 exd4 Bc4", n: "Scotch Gambit", eco: "C44" },
    { m: "e4 e5 Nf3 Nf6", n: "Petrov's Defense", eco: "C42" },
    { m: "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4", n: "Petrov's Defense: Classical", eco: "C43" },
    { m: "e4 e5 Nf3 d6", n: "Philidor Defense", eco: "C41" },
    { m: "e4 e5 Nf3 d6 d4", n: "Philidor Defense: Exchange Variation", eco: "C41" },
    { m: "e4 e5 Nf3 d6 d4 Bg4", n: "Philidor Defense: Bishop Pin", eco: "C41" },
    { m: "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5", n: "Philidor Defense: Morphy's Opera Game Line", eco: "C41" },
    { m: "e4 e5 Nf3 d6 d4 Nf6", n: "Philidor Defense: Main Line", eco: "C41" },
    { m: "e4 e5 Nf3 d6 d4 exd4 Nxd4", n: "Philidor Defense: Open", eco: "C41" },
    { m: "e4 e5 f4", n: "King's Gambit", eco: "C30" },
    { m: "e4 e5 f4 exf4", n: "King's Gambit Accepted", eco: "C33" },
    { m: "e4 e5 Nc3", n: "Vienna Game", eco: "C25" },
    { m: "e4 e5 Bc4", n: "Bishop's Opening", eco: "C23" },
    { m: "e4 e5 d4 exd4 Qxd4", n: "Center Game", eco: "C22" },
    // Sicilian
    { m: "e4 c5", n: "Sicilian Defense", eco: "B20" },
    { m: "e4 c5 Nf3 d6", n: "Sicilian Defense: Modern Variations", eco: "B50" },
    { m: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3", n: "Sicilian Defense: Open", eco: "B54" },
    { m: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", n: "Sicilian Defense: Najdorf", eco: "B90" },
    { m: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6", n: "Sicilian Defense: Dragon", eco: "B70" },
    { m: "e4 c5 Nf3 Nc6", n: "Sicilian Defense: Old Sicilian", eco: "B30" },
    { m: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 e5", n: "Sicilian Defense: Sveshnikov-type", eco: "B33" },
    { m: "e4 c5 Nf3 e6", n: "Sicilian Defense: French Variation", eco: "B40" },
    { m: "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6", n: "Sicilian Defense: Kan", eco: "B41" },
    { m: "e4 c5 Nc3", n: "Sicilian Defense: Closed", eco: "B23" },
    { m: "e4 c5 c3", n: "Sicilian Defense: Alapin", eco: "B22" },
    { m: "e4 c5 d4 cxd4 c3", n: "Sicilian Defense: Smith-Morra Gambit", eco: "B21" },
    { m: "e4 c5 Nf3 Nc6 Bb5", n: "Sicilian Defense: Rossolimo", eco: "B30" },
    // Other 1.e4
    { m: "e4 e6", n: "French Defense", eco: "C00" },
    { m: "e4 e6 d4 d5", n: "French Defense: Normal", eco: "C01" },
    { m: "e4 e6 d4 d5 Nc3", n: "French Defense: Classical", eco: "C10" },
    { m: "e4 e6 d4 d5 Nc3 Bb4", n: "French Defense: Winawer", eco: "C15" },
    { m: "e4 e6 d4 d5 Nd2", n: "French Defense: Tarrasch", eco: "C03" },
    { m: "e4 e6 d4 d5 e5", n: "French Defense: Advance", eco: "C02" },
    { m: "e4 c6", n: "Caro-Kann Defense", eco: "B10" },
    { m: "e4 c6 d4 d5 Nc3 dxe4 Nxe4", n: "Caro-Kann Defense: Classical", eco: "B18" },
    { m: "e4 c6 d4 d5 e5", n: "Caro-Kann Defense: Advance", eco: "B12" },
    { m: "e4 c6 d4 d5 exd5 cxd5", n: "Caro-Kann Defense: Exchange", eco: "B13" },
    { m: "e4 d5", n: "Scandinavian Defense", eco: "B01" },
    { m: "e4 d5 exd5 Qxd5 Nc3 Qa5", n: "Scandinavian Defense: Main Line", eco: "B01" },
    { m: "e4 d6", n: "Pirc Defense", eco: "B07" },
    { m: "e4 g6", n: "Modern Defense", eco: "B06" },
    { m: "e4 Nf6", n: "Alekhine's Defense", eco: "B02" },
    { m: "e4", n: "King's Pawn Opening", eco: "B00" },
    // 1.d4
    { m: "d4 d5", n: "Queen's Pawn Game", eco: "D00" },
    { m: "d4 d5 c4", n: "Queen's Gambit", eco: "D06" },
    { m: "d4 d5 c4 dxc4", n: "Queen's Gambit Accepted", eco: "D20" },
    { m: "d4 d5 c4 e6", n: "Queen's Gambit Declined", eco: "D30" },
    { m: "d4 d5 c4 e6 Nc3 Nf6 Bg5", n: "Queen's Gambit Declined: Orthodox", eco: "D50" },
    { m: "d4 d5 c4 e6 Nc3 Nf6 Nf3 Be7", n: "Queen's Gambit Declined: Main Line", eco: "D37" },
    { m: "d4 d5 c4 c6", n: "Slav Defense", eco: "D10" },
    { m: "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6", n: "Semi-Slav Defense", eco: "D43" },
    { m: "d4 d5 Nf3 Nf6 Bf4", n: "London System", eco: "D02" },
    { m: "d4 Nf6 Nf3 e6 Bf4", n: "London System", eco: "A46" },
    { m: "d4 d5 Bf4", n: "London System", eco: "D00" },
    { m: "d4 Nf6", n: "Indian Defense", eco: "A45" },
    { m: "d4 Nf6 c4 e6", n: "Indian Defense: Normal", eco: "E00" },
    { m: "d4 Nf6 c4 e6 Nc3 Bb4", n: "Nimzo-Indian Defense", eco: "E20" },
    { m: "d4 Nf6 c4 e6 Nf3 b6", n: "Queen's Indian Defense", eco: "E12" },
    { m: "d4 Nf6 c4 g6", n: "King's Indian Defense", eco: "E60" },
    { m: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6", n: "King's Indian Defense: Normal", eco: "E70" },
    { m: "d4 Nf6 c4 g6 Nc3 d5", n: "Grünfeld Defense", eco: "D80" },
    { m: "d4 Nf6 c4 c5 d5", n: "Benoni Defense", eco: "A60" },
    { m: "d4 f5", n: "Dutch Defense", eco: "A80" },
    { m: "d4 d6", n: "Pirc/Old Indian Setup", eco: "A41" },
    { m: "d4", n: "Queen's Pawn Opening", eco: "A40" },
    // Flank
    { m: "c4", n: "English Opening", eco: "A10" },
    { m: "c4 e5", n: "English Opening: Reversed Sicilian", eco: "A20" },
    { m: "c4 c5", n: "English Opening: Symmetrical", eco: "A30" },
    { m: "Nf3", n: "Réti Opening", eco: "A04" },
    { m: "Nf3 d5 g3", n: "Réti Opening: King's Indian Attack", eco: "A07" },
    { m: "Nf3 d5 c4", n: "Réti Opening", eco: "A09" },
    { m: "g3", n: "King's Fianchetto Opening", eco: "A00" },
    { m: "b3", n: "Nimzo-Larsen Attack", eco: "A01" },
    { m: "f4", n: "Bird's Opening", eco: "A02" }
  ];

  const BOOK_POSITIONS = new Set();
  const BOOK_NAMES = new Map(); // positionKey -> opening (last line wins; lists go broad → specific)

  (function buildBook() {
    for (const opening of OPENINGS) {
      const chess = new Chess();
      let ok = true;

      for (const san of opening.m.split(" ")) {
        let applied = null;
        try { applied = chess.move(san); } catch (_) { applied = null; }
        if (!applied) { ok = false; break; }
        BOOK_POSITIONS.add(positionKey(chess.fen()));
      }

      if (ok) BOOK_NAMES.set(positionKey(chess.fen()), opening);
    }
  })();

  // Counts consecutive book plies from the start and names the deepest opening reached.
  function findBook(fens) {
    let bookPlies = 0;
    let opening = null;

    for (let i = 1; i < fens.length; i++) {
      const key = positionKey(fens[i]);
      if (!BOOK_POSITIONS.has(key)) break;
      bookPlies = i;
      if (BOOK_NAMES.has(key)) opening = BOOK_NAMES.get(key);
    }

    return { bookPlies, opening };
  }

  // ---------------- Move grading ----------------
  function classifyByLoss(loss) {
    if (loss <= EP_THRESHOLDS.best) return "best";
    if (loss <= EP_THRESHOLDS.excellent) return "excellent";
    if (loss <= EP_THRESHOLDS.good) return "good";
    if (loss <= EP_THRESHOLDS.inaccuracy) return "inaccuracy";
    if (loss <= EP_THRESHOLDS.mistake) return "mistake";
    return "blunder";
  }

  // Net material (in pawns) the mover gives up once the engine's expected
  // continuation settles. Only even PV lengths are used so the mover has the
  // last word (recaptures are counted).
  function sacrificedMaterial(move, beforeFen, after) {
    if (after.terminal || !after.lines.length) return 0;

    const pv = after.lines[0].pv || [];
    let plies = Math.min(pv.length, 4);
    if (plies % 2 === 1) plies -= 1;
    if (plies < 2) return 0;

    const chess = new Chess(after.fen);
    let played = 0;

    for (let i = 0; i < plies; i++) {
      if (!safeMove(chess, pv[i])) break;
      played++;
    }

    if (played % 2 === 1) {
      // Illegal PV move on the mover's reply: drop the unmatched ply.
      chess.undo();
      played--;
    }
    if (played < 2) return 0;

    const before = materialBalance(beforeFen, move.color);
    const end = materialBalance(chess.fen(), move.color);
    return before - end;
  }

  function scoreGame(moves, fens, evals, ratings, bookPlies) {
    const analyzed = [];

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      const color = move.color;
      const rating = ratings[color];
      const before = evals[i];
      const after = evals[i + 1];
      const playedUci = moveToUci(move);

      const bestLine = before.lines[0];
      const bestUci = bestLine.move;
      const playedLine = before.lines.find(line => line.move === playedUci) || null;

      let bestEP = epFor(before, bestLine, color, rating);
      let playedEP;

      if (after.terminal) {
        playedEP = epFor(after, null, color, rating);      // exact result
      } else if (playedLine) {
        playedEP = epFor(before, playedLine, color, rating); // same search as best
      } else {
        playedEP = epFor(after, after.lines[0], color, rating);
      }

      if (playedEP > bestEP) bestEP = playedEP; // search noise: never negative loss
      const loss = playedUci === bestUci ? 0 : Math.max(0, bestEP - playedEP);

      const isBook = i < bookPlies;
      const isForced = before.legalMoves === 1;
      let category;

      if (isBook) {
        category = "theory";
      } else if (isForced) {
        category = "forced";
      } else {
        category = classifyByLoss(loss);

        // ---- Brilliant: a sound piece sacrifice ----
        const sacrifice = sacrificedMaterial(move, before.fen, after);
        if (
          loss <= BRILLIANT_MAX_LOSS &&
          sacrifice >= BRILLIANT_MIN_SACRIFICE &&
          playedEP >= BRILLIANT_MIN_EP_AFTER &&
          // "Already completely winning" blocks Brilliant, except when the
          // sacrifice is the key to a forced mate.
          (bestEP <= BRILLIANT_MAX_EP_BEFORE || (bestLine.mate !== null && bestLine.mate > 0))
        ) {
          category = "brilliant";
        }

        // ---- Great: the (nearly) only good move ----
        else if (loss <= EP_THRESHOLDS.best && before.lines.length >= 2) {
          const secondEP = epFor(before, before.lines[1], color, rating);
          const prev = moves[i - 1];
          const isRecapture =
            prev && prev.captured && move.captured && prev.to === move.to;

          if (
            bestEP - secondEP >= GREAT_GAP &&
            bestEP < GREAT_MAX_ALREADY_WON &&
            !isRecapture
          ) {
            category = "great";
          }
        }

        // ---- Miss: opponent slipped, you failed to punish ----
        if (
          (category === "mistake" || category === "blunder" || category === "inaccuracy") &&
          loss >= MISS_MIN_LOSS &&
          i > 0 &&
          analyzed[i - 1] &&
          analyzed[i - 1].category !== "theory" &&
          analyzed[i - 1].loss >= MISS_OPP_MIN_LOSS &&
          bestEP >= MISS_MIN_OPPORTUNITY &&
          playedEP >= MISS_MIN_EP_AFTER
        ) {
          category = "miss";
        }
      }

      // Lichess-style per-move accuracy from win% lost.
      const winLostPct = loss * 100;
      const moveAccuracy = clamp(
        103.1668 * Math.exp(-0.04354 * winLostPct) - 3.1669, 0, 100
      );

      analyzed.push({
        san: move.san,
        color,
        category,
        loss,
        accuracy: moveAccuracy,
        evalWhitePov: whitePawns(after),
        bestMove: uciToSan(before.fen, bestUci),
        bestMoveUci: bestUci,
        playedMove: playedUci,
        beforeEval: before,
        afterEval: after
      });
    }

    return analyzed;
  }

  // ---------------- Accuracy (volatility-weighted + harmonic mean) ----------------
  function stdev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  function gameAccuracy(analyzed, winSeries, color) {
    const windowSize = clamp(Math.floor(winSeries.length / 10), 2, 8);
    const entries = [];

    analyzed.forEach((move, index) => {
      if (move.color !== color || move.category === "theory") return;

      const window = winSeries.slice(index, index + windowSize);
      const weight = clamp(stdev(window), 0.5, 12);
      entries.push({ accuracy: move.accuracy, weight });
    });

    if (!entries.length) return null;

    const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
    const weightedMean =
      entries.reduce((s, e) => s + e.accuracy * e.weight, 0) / totalWeight;

    const harmonicMean =
      entries.length /
      entries.reduce((s, e) => s + 1 / Math.max(e.accuracy, 1), 0);

    return (weightedMean + harmonicMean) / 2;
  }

  // ---------------- DOM helpers ----------------
  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function setHTML(id, value) {
    const element = document.getElementById(id);
    if (element) element.innerHTML = value;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function setProgress(message) {
    statusEl.textContent = message;
  }

  function selectedDepth(fallback) {
    const el = document.getElementById("depth");
    const value = el ? parseInt(el.value, 10) : NaN;
    return Number.isFinite(value) && value >= 8 && value <= 30 ? value : fallback;
  }

  // ---------------- Single FEN analysis ----------------
  async function analyzeFen(chess, fen) {
    setProgress("Evaluating position with Stockfish...");
    const evaluation = await evaluatePosition(fen, selectedDepth(FEN_DEPTH));

    setText("white-acc", "—");
    setText("black-acc", "—");
    setText("white-name", "");
    setText("black-name", "");
    setHTML("breakdown", "");
    setText("opening", "—");

    let html =
      "Evaluation: <b>" + escapeHTML(formatEval(evaluation)) + "</b>";

    if (!evaluation.terminal) {
      const whiteEP = epFor(evaluation, evaluation.lines[0], "w", DEFAULT_RATING);
      html += " (Stockfish, depth " + evaluation.depth + ")<br>" +
        "White expected score: <b>" + (whiteEP * 100).toFixed(1) + "%</b> · " +
        "Black: <b>" + ((1 - whiteEP) * 100).toFixed(1) + "%</b><br>" +
        "<br><b>Top lines</b><br>";

      for (const line of evaluation.lines) {
        const sign = evaluation.turn === "w" ? 1 : -1;
        const shown = line.mate !== null
          ? "#" + (line.mate * sign > 0 ? "+" : "") + line.mate * sign
          : ((line.cp * sign) / 100 > 0 ? "+" : "") + ((line.cp * sign) / 100).toFixed(2);

        html += line.index + ". " + escapeHTML(uciToSan(fen, line.move)) +
          " (" + escapeHTML(shown) + ")<br>";
      }
    }

    setHTML("summary", html);
    setHTML("moves", "<em>Single position — no move list or game accuracy.</em>");

    const graph = document.getElementById("eval-graph");
    if (graph) graph.style.display = "none";
  }

  // ---------------- Full PGN analysis ----------------
  async function analyzePgn(chess) {
    const headers = typeof chess.header === "function" ? chess.header() : {};
    const whiteName = headers.White || "White";
    const blackName = headers.Black || "Black";
    const startFen = headers.FEN && headers.SetUp !== "0" ? headers.FEN : null;

    const ratings = {
      w: parseInt(headers.WhiteElo, 10) || DEFAULT_RATING,
      b: parseInt(headers.BlackElo, 10) || DEFAULT_RATING
    };

    const moves = chess.history({ verbose: true });

    if (!moves.length) {
      throw new Error("No valid moves were found. Check the PGN format.");
    }

    const depth = selectedDepth(DEFAULT_DEPTH);
    const replay = startFen ? new Chess(startFen) : new Chess();
    const fens = [replay.fen()];

    for (const move of moves) {
      const applied = safeMove(replay, moveToUci(move));
      if (!applied) throw new Error("Could not replay move: " + move.san);
      fens.push(replay.fen());
    }

    // Book moves are not graded, so their positions need no engine time.
    const { bookPlies, opening } = startFen
      ? { bookPlies: 0, opening: null }
      : findBook(fens);

    // Evaluate each remaining position once (best line + alternative).
    const evals = [];
    const startedAt = Date.now();
    const toSearch = fens.length - bookPlies;

    for (let i = 0; i < fens.length; i++) {
      if (i < bookPlies) {
        const turn = fens[i].split(" ")[1];
        evals.push({
          fen: fens[i], turn, terminal: null, stub: true, depth: 0,
          lines: [{ index: 1, move: null, cp: 0, mate: null, pv: [], depth: 0 }]
        });
        continue;
      }

      const done = i - bookPlies;
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = done > 0 ? Math.round((elapsed / done) * (toSearch - done)) : null;

      setProgress(
        "Analyzing position " + (done + 1) + " / " + toSearch +
        " (depth " + depth + ")" + (eta !== null ? " — about " + eta + "s left" : "") + "..."
      );

      evals.push(await evaluatePosition(fens[i], depth));
    }

    const analyzed = scoreGame(moves, fens, evals, ratings, bookPlies);

    // Win% series (White POV, 0..100) used for volatility weighting.
    const winSeries = evals.map(
      ev => epFor(ev, ev.lines[0], "w", DEFAULT_RATING) * 100
    );

    const whiteAcc = gameAccuracy(analyzed, winSeries, "w");
    const blackAcc = gameAccuracy(analyzed, winSeries, "b");
    const whiteAccText = whiteAcc === null ? "—" : whiteAcc.toFixed(1);
    const blackAccText = blackAcc === null ? "—" : blackAcc.toFixed(1);

    setText("white-acc", whiteAcc === null ? "—" : whiteAccText + "%");
    setText("black-acc", blackAcc === null ? "—" : blackAccText + "%");
    setText("white-name", whiteName);
    setText("black-name", blackName);

    // Category counts
    const categories = [
      "brilliant", "great", "best", "excellent", "good", "theory", "forced",
      "inaccuracy", "mistake", "miss", "blunder"
    ];

    const labels = {
      brilliant: "Brilliant", great: "Great", best: "Best", excellent: "Excellent",
      good: "Good", theory: "Book", forced: "Forced", inaccuracy: "Inaccuracy",
      mistake: "Mistake", miss: "Miss", blunder: "Blunder"
    };

    const counts = { w: {}, b: {} };
    for (const category of categories) {
      counts.w[category] = 0;
      counts.b[category] = 0;
    }

    for (const move of analyzed) {
      if (counts[move.color][move.category] !== undefined) {
        counts[move.color][move.category]++;
      }
    }

    let breakdownHTML =
      "<tr><th>Category</th><th>♔ White</th><th>♚ Black</th></tr>";

    for (const category of categories) {
      breakdownHTML +=
        "<tr><td class='cat-" + category + "'>" + labels[category] +
        "</td><td>" + counts.w[category] +
        "</td><td>" + counts.b[category] + "</td></tr>";
    }

    setHTML("breakdown", breakdownHTML);

    setHTML(
      "opening",
      opening
        ? "<b>" + escapeHTML(opening.n) + "</b> (" + escapeHTML(opening.eco) + ")"
        : "<em>Not recognized by the built-in opening list.</em>"
    );

    const count = cat => analyzed.filter(m => m.category === cat).length;
    const graded = analyzed.filter(m => m.category !== "theory");
    const avgLoss = graded.length
      ? graded.reduce((sum, m) => sum + m.loss, 0) / graded.length
      : 0;

    setHTML(
      "summary",
      "Total plies: <b>" + moves.length + "</b> · Book plies: <b>" + bookPlies + "</b><br>" +
      "Brilliant: <b>" + count("brilliant") + "</b> · Great: <b>" + count("great") +
      "</b> · Inaccuracies: <b>" + count("inaccuracy") +
      "</b> · Mistakes: <b>" + count("mistake") +
      "</b> · Misses: <b>" + count("miss") +
      "</b> · Blunders: <b>" + count("blunder") + "</b><br>" +
      "White accuracy: <b>" + escapeHTML(whiteAccText) + (whiteAcc === null ? "" : "%") +
      "</b> (" + ratings.w + ") · Black accuracy: <b>" + escapeHTML(blackAccText) +
      (blackAcc === null ? "" : "%") + "</b> (" + ratings.b + ")<br>" +
      "Average expected points lost per move: <b>" + (avgLoss * 100).toFixed(1) + "%</b><br>" +
      "<small>Stockfish depth " + depth + ", MultiPV " + MULTIPV +
      ". Accuracy is a ChessIQ estimate (Lichess formula), not an official Chess.com score.</small>"
    );

    // Move list
    const movesEl = document.getElementById("moves");

    if (movesEl) {
      movesEl.innerHTML = "";

      analyzed.forEach((move, index) => {
        const moveNumber = Math.floor(index / 2) + 1;
        const prefix = move.color === "w"
          ? moveNumber + ". "
          : index === 0 ? moveNumber + "... " : "";

        const span = document.createElement("span");
        span.className = "move " + move.category;
        span.textContent = prefix + move.san;

        span.title =
          labels[move.category] + " — expected points lost: " +
          (move.loss * 100).toFixed(1) + "%" +
          " — eval after: " + formatEval(move.afterEval) +
          (move.bestMove && move.bestMoveUci !== move.playedMove
            ? " — engine best: " + move.bestMove
            : "");

        movesEl.appendChild(span);
        movesEl.appendChild(document.createTextNode(" "));
      });
    }

    drawEvalGraph(analyzed);
  }

  // ---------------- Evaluation graph ----------------
  function drawEvalGraph(analyzed) {
    const canvas = document.getElementById("eval-graph");
    if (!canvas || !analyzed.length) return;

    canvas.style.display = "block";

    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const yFor = value =>
      height / 2 - (clamp(value, -6, 6) / 6) * (height / 2 - 10);

    ctx.strokeStyle = "#2a2a3e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    ctx.strokeStyle = "#1a1a24";
    ctx.beginPath();
    ctx.moveTo(0, height / 4);
    ctx.lineTo(width, height / 4);
    ctx.moveTo(0, 3 * height / 4);
    ctx.lineTo(width, 3 * height / 4);
    ctx.stroke();

    const points = analyzed.map((move, index) => ({
      x: analyzed.length === 1 ? width / 2 : (index / (analyzed.length - 1)) * width,
      y: yFor(move.evalWhitePov),
      category: move.category
    }));

    ctx.beginPath();
    ctx.moveTo(points[0].x, height / 2);
    for (const point of points) ctx.lineTo(point.x, point.y);
    ctx.lineTo(points[points.length - 1].x, height / 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(124, 156, 245, 0.15)";
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = "#7c9cf5";
    ctx.lineWidth = 2;
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();

    const dotColors = {
      blunder: "#fa412d", miss: "#ee6b55", mistake: "#e58f2a",
      brilliant: "#1baca6", great: "#5c8bb0"
    };

    points.forEach(point => {
      const color = dotColors[point.category];
      if (!color) return;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  }

  // ---------------- Main button ----------------
  btnEl.addEventListener("click", async () => {
    const text = inputEl.value.trim();

    if (!text) {
      statusEl.textContent = "Paste a PGN or FEN first.";
      return;
    }

    if (btnEl.disabled) return;

    btnEl.disabled = true;
    resultsEl.style.display = "none";
    statusEl.textContent = "Starting Stockfish...";

    try {
      await initEngine();

      const chess = new Chess();
      const format = detectFormat(text);

      if (format === "FEN") {
        let loaded;
        try { loaded = chess.load(text); }
        catch (_) { loaded = false; }

        if (loaded === false) throw new Error("Invalid FEN position.");

        await analyzeFen(chess, chess.fen());
      } else if (format === "PGN") {
        try {
          loadPgnCompat(chess, text);
        } catch (error) {
          throw new Error("Could not parse PGN: " + error.message);
        }

        await analyzePgn(chess);
      } else {
        throw new Error("Could not detect the input format. Paste a valid PGN or FEN.");
      }

      resultsEl.style.display = "block";
      statusEl.textContent = "Analysis complete.";
    } catch (error) {
      console.error("ChessIQ analysis failed:", error);
      statusEl.textContent = "Error: " + (error?.message || String(error));
    } finally {
      btnEl.disabled = false;
    }
  });
})();
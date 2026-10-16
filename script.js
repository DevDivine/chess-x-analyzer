document.addEventListener('DOMContentLoaded', () => {
  const chessBoard = document.getElementById('chessBoard');
  const statusEl = document.getElementById('status');
  const capturedWhite = document.getElementById('capturedWhite');
  const capturedBlack = document.getElementById('capturedBlack');
  const newGameBtn = document.getElementById('newGameBtn');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const flipBoardBtn = document.getElementById('flipBoardBtn');
  const resultOverlay = document.getElementById('resultOverlay');
  const resultCard = document.getElementById('resultCard');
  const resultText = document.getElementById('resultText');
  const changeTurnBtn = document.getElementById('changeTurnBtn');
  const restartBtn = document.getElementById('restartBtn');
  const sounds = {
    move: new Audio('audio/move.mp3'),
    check: new Audio('audio/check.mp3'),
    promote: new Audio('audio/promote.mp3'),
    castle: new Audio('audio/castle.mp3'),
    gameEnd: new Audio('audio/game-end.mp3'),
    capture: new Audio('audio/capture.mp3')
  };

  for (const key in sounds) {
    sounds[key].volume = 0.5;
  }

  const pieceImages = {
    'wp': 'images/wp.png', 'wr': 'images/wr.png', 'wn': 'images/wn.png', 'wb': 'images/wb.png', 'wq': 'images/wq.png', 'wk': 'images/wk.png',
    'bp': 'images/bp.png', 'br': 'images/br.png', 'bn': 'images/bn.png', 'bb': 'images/bb.png', 'bq': 'images/bq.png', 'bk': 'images/bk.png'
  };

  let board = [];
  let currentPlayer = 'w';
  let selected = null;
  let legalMoves = []; // for selected piece
  let moveHistory = [];
  let redoStack = []; // stack for redo functionality
  let captured = { w: [], b: [] }; // captured[p] = pieces captured BY p
  let enPassantTarget = null; // {row,col} where en-passant capture is possible
  let castleRights = { w: { K: true, Q: true }, b: { K: true, Q: true } };
  let boardFlipped = false;
  let gameOver = false;

  function resetState() {
    board = [
      ['br', 'bn', 'bb', 'bq', 'bk', 'bb', 'bn', 'br'],
      ['bp', 'bp', 'bp', 'bp', 'bp', 'bp', 'bp', 'bp'],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['wp', 'wp', 'wp', 'wp', 'wp', 'wp', 'wp', 'wp'],
      ['wr', 'wn', 'wb', 'wq', 'wk', 'wb', 'wn', 'wr']
    ];
    currentPlayer = 'w';
    selected = null;
    legalMoves = [];
    moveHistory = [];
    redoStack = [];
    captured = { w: [], b: [] };
    enPassantTarget = null;
    castleRights = { w: { K: true, Q: true }, b: { K: true, Q: true } };
    boardFlipped = false;
    gameOver = false;

    render();
    updateCapturedUI();
    updateStatus();
    updateMoveHistoryUI(); // ADDED THIS LINE
    updateButtonStates();

    if (changeTurnBtn) changeTurnBtn.disabled = false;
  }

  function updateButtonStates() {
    undoBtn.disabled = moveHistory.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function render() {
    chessBoard.innerHTML = '';
    chessBoard.style.transform = boardFlipped ? 'rotate(180deg)' : '';

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = document.createElement('div');
        sq.classList.add('square', (r + c) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.row = r;
        sq.dataset.col = c;

        const piece = board[r][c];
        if (piece) {
          const img = document.createElement('img');
          img.src = pieceImages[piece];
          img.alt = piece;
          img.classList.add('chess-piece');
          if (boardFlipped) img.style.transform = 'rotate(180deg)';
          sq.appendChild(img);
        }

        sq.addEventListener('click', () => onSquareClick(r, c));
        chessBoard.appendChild(sq);
      }
    }

    if (isKingInCheck("w") || isKingInCheck("b")) {
      sounds.check.currentTime = 0;
      sounds.check.play();
    }

    ["w", "b"].forEach(color => {
      if (isKingInCheck(color)) {
        const kingPos = findKing(color);
        if (kingPos) {
          const [kr, kc] = kingPos;
          const el = document.querySelector(`.square[data-row="${kr}"][data-col="${kc}"]`);
          if (el) el.classList.add("king-check");
        }
      }
    });


    if (selected) {
      const sqEl = document.querySelector(`.square[data-row="${selected.r}"][data-col="${selected.c}"]`);
      if (sqEl) sqEl.classList.add('selected');

      legalMoves.forEach(([tr, tc]) => {
        const targetEl = document.querySelector(`.square[data-row="${tr}"][data-col="${tc}"]`);
        if (targetEl) {
          const dot = document.createElement('div');
          const isCapture = board[tr][tc] && board[tr][tc][0] !== selected.piece[0];
          dot.classList.add('dot');
          if (isCapture) dot.classList.add('capture');
          targetEl.appendChild(dot);
        }
      });
    }
  }

  function updateStatus(text) {
    if (text) statusEl.textContent = text;
    else statusEl.textContent = `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn`;
  }

  function updateCapturedUI() {
    capturedWhite.innerHTML = '<strong>White captured:</strong> ';
    capturedBlack.innerHTML = '<strong>Black captured:</strong> ';

    captured.w.forEach(p => {
      const img = document.createElement('img');
      img.src = pieceImages[p];
      img.classList.add('captured-piece');
      capturedWhite.appendChild(img);
    });

    captured.b.forEach(p => {
      const img = document.createElement('img');
      img.src = pieceImages[p];
      img.classList.add('captured-piece');
      capturedBlack.appendChild(img);
    });
  }

  function findKing(color) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (board[r][c] === color + 'k') return [r, c];
      }
    }
    return null;
  }

  function inBoard(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  function squaresAttackedBy(color) {
    const attacks = new Set();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || p[0] !== color) continue;
        const type = p[1];

        if (type === 'p') {
          const dir = color === 'w' ? -1 : 1;
          [[dir, -1], [dir, 1]].forEach(([dr, dc]) => {
            const rr = r + dr, cc = c + dc;
            if (inBoard(rr, cc)) attacks.add(rr + ',' + cc);
          });
        } else if (type === 'n') {
          [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
            .forEach(([dr, dc]) => {
              const rr = r + dr, cc = c + dc;
              if (inBoard(rr, cc)) attacks.add(rr + ',' + cc);
            });
        } else if (type === 'b' || type === 'q') {
          [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([dr, dc]) => {
            let rr = r + dr, cc = c + dc;
            while (inBoard(rr, cc)) {
              attacks.add(rr + ',' + cc);
              if (board[rr][cc]) break;
              rr += dr; cc += dc;
            }
          });
        }

        if (type === 'r' || type === 'q') {
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
            let rr = r + dr, cc = c + dc;
            while (inBoard(rr, cc)) {
              attacks.add(rr + ',' + cc);
              if (board[rr][cc]) break;
              rr += dr; cc += dc;
            }
          });
        }

        if (type === 'k') {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const rr = r + dr, cc = c + dc;
              if (inBoard(rr, cc)) attacks.add(rr + ',' + cc);
            }
          }
        }
      }
    }
    return attacks;
  }

  function isKingInCheck(color) {
    const kingPos = findKing(color);
    if (!kingPos) return false;
    const [kr, kc] = kingPos;
    const attackerColor = color === 'w' ? 'b' : 'w';
    const attacks = squaresAttackedBy(attackerColor);
    return attacks.has(kr + ',' + kc);
  }

  function pseudoLegalMovesFor(r, c) {
    const p = board[r][c];
    if (!p) return [];
    const color = p[0], type = p[1];
    const moves = [];

    if (type === 'p') {
      const dir = color === 'w' ? -1 : 1;
      if (inBoard(r + dir, c) && !board[r + dir][c]) moves.push([r + dir, c]);
      const start = color === 'w' ? 6 : 1;
      if (r === start && !board[r + dir][c] && !board[r + 2 * dir][c]) moves.push([r + 2 * dir, c]);
      [[dir, -1], [dir, 1]].forEach(([dr, dc]) => {
        const rr = r + dr, cc = c + dc;
        if (inBoard(rr, cc) && board[rr][cc] && board[rr][cc][0] !== color) moves.push([rr, cc]);
      });
      if (enPassantTarget) {
        if (Math.abs(enPassantTarget.col - c) === 1 && enPassantTarget.row === r + dir) {
          moves.push([enPassantTarget.row, enPassantTarget.col]);
        }
      }
    } else if (type === 'n') {
      [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
        .forEach(([dr, dc]) => {
          const rr = r + dr, cc = c + dc;
          if (inBoard(rr, cc) && (!board[rr][cc] || board[rr][cc][0] !== color)) moves.push([rr, cc]);
        });
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const dirs = (type === 'b') ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
        : (type === 'r') ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
        : [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
      dirs.forEach(([dr, dc]) => {
        let rr = r + dr, cc = c + dc;
        while (inBoard(rr, cc)) {
          if (!board[rr][cc]) moves.push([rr, cc]);
          else {
            if (board[rr][cc][0] !== color) moves.push([rr, cc]);
            break;
          }
          rr += dr; cc += dc;
        }
      });
    } else if (type === 'k') {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr, cc = c + dc;
          if (inBoard(rr, cc) && (!board[rr][cc] || board[rr][cc][0] !== color)) moves.push([rr, cc]);
        }
      }

      if (castleRights[color].K) {
        if (!board[r][c + 1] && !board[r][c + 2]) moves.push([r, c + 2]);
      }
      if (castleRights[color].Q) {
        if (!board[r][c - 1] && !board[r][c - 2] && !board[r][c - 3]) moves.push([r, c - 2]);
      }
    }

    return moves;
  }

  function generateNotation(piece, fromR, fromC, toR, toC, capturedPiece, castleType) {
    const files = 'abcdefgh';
    const fromFile = files[fromC];
    const toFile = files[toC];
    const toRank = 8 - toR;

    if (castleType) return castleType === 'K' ? 'O-O' : 'O-O-O';

    if (piece[1] === 'p') {
      if (capturedPiece) return `${fromFile}x${toFile}${toRank}`;
      return `${toFile}${toRank}`;
    }

    const mapPieceSymbol = { 'n': 'N', 'b': 'B', 'r': 'R', 'q': 'Q', 'k': 'K' };
    const pieceSymbol = mapPieceSymbol[piece[1]] || piece[1].toUpperCase();

    if (capturedPiece) return `${pieceSymbol}x${toFile}${toRank}`;
    return `${pieceSymbol}${toFile}${toRank}`;
  }

  function doMove(fromR, fromC, toR, toC, record = true) {
    const piece = board[fromR][fromC];
    const capturedPiece = board[toR][toC] || null;
    const prevEnPassant = enPassantTarget ? { row: enPassantTarget.row, col: enPassantTarget.col } : null;

    let epCaptured = null;
    if (piece && piece[1] === 'p' && enPassantTarget && toR === enPassantTarget.row && toC === enPassantTarget.col && !capturedPiece) {
      const capRow = piece[0] === 'w' ? toR + 1 : toR - 1;
      epCaptured = board[capRow][toC];
      board[capRow][toC] = '';
    }

    let rookMove = null;
    let castleType = null;
    if (piece && piece[1] === 'k' && Math.abs(toC - fromC) === 2) {
      if (toC === 6) {
        board[toR][5] = board[toR][7];
        rookMove = { from: [toR, 7], to: [toR, 5] };
        castleType = 'K';
        board[toR][7] = '';
      } else if (toC === 2) {
        board[toR][3] = board[toR][0];
        rookMove = { from: [toR, 0], to: [toR, 3] };
        castleType = 'Q';
        board[toR][0] = '';
      }
    }

    board[toR][toC] = board[fromR][fromC];
    board[fromR][fromC] = '';

    let newEnPassant = null;
    if (piece && piece[1] === 'p' && Math.abs(toR - fromR) === 2) {
      newEnPassant = { row: (fromR + toR) / 2, col: fromC };
    }
    enPassantTarget = newEnPassant;

    const prevCastle = JSON.parse(JSON.stringify(castleRights));

    if (piece && piece[1] === 'k') castleRights[piece[0]] = { K: false, Q: false };
    if (piece && piece[1] === 'r') {
      if (fromC === 0) castleRights[piece[0]].Q = false;
      if (fromC === 7) castleRights[piece[0]].K = false;
    }

    if (capturedPiece && capturedPiece[1] === 'r') {
      const opp = capturedPiece[0];
      if (toC === 0) castleRights[opp].Q = false;
      if (toC === 7) castleRights[opp].K = false;
    }

    const notationCaptured = capturedPiece || epCaptured || null;
    const notation = piece ? generateNotation(piece, fromR, fromC, toR, toC, notationCaptured, castleType) : '';

    const moveRecord = {
      from: [fromR, fromC],
      to: [toR, toC],
      piece,
      captured: capturedPiece,
      epCaptured,
      prevEnPassant,
      prevCastle,
      rookMove,
      notation,
      player: piece ? piece[0] : null
    };

    if (record) {
      moveHistory.push(moveRecord);
      if (redoStack.length > 0) redoStack = [];
      updateMoveHistoryUI();
      updateButtonStates();
    }

    return moveRecord;
  }

  function executeRedoMove(moveRecord) {
    const [fromR, fromC] = moveRecord.from;
    const [toR, toC] = moveRecord.to;

    const newMoveRecord = doMove(fromR, fromC, toR, toC, true);

    if (moveRecord.captured) {
      captured[newMoveRecord.piece[0]].push(moveRecord.captured);
    }
    if (moveRecord.epCaptured) {
      captured[newMoveRecord.piece[0]].push(moveRecord.epCaptured);
    }

    if (moveRecord.promotedPiece) {
      board[toR][toC] = moveRecord.promotedPiece;
      newMoveRecord.notation = moveRecord.notation;
    }

    currentPlayer = moveRecord.player === 'w' ? 'b' : 'w';

    updateCapturedUI();
    updateMoveHistoryUI();
    updateButtonStates();
  }

  function updateMoveHistoryUI() {
    const container = document.getElementById('moveHistory');
    if (!container) return;

    const moveEntries = container.querySelectorAll('.move-row');
    moveEntries.forEach(entry => entry.remove());

    const turns = [];
    let currentTurn = { white: null, black: null };

    for (const mv of moveHistory) {
      if (mv.player === 'w') {
        if (currentTurn.white !== null || currentTurn.black !== null) {
          turns.push(currentTurn);
          currentTurn = { white: mv, black: null };
        } else {
          currentTurn.white = mv;
        }
      } else if (mv.player === 'b') {
        if (currentTurn.white === null && currentTurn.black === null) {
          currentTurn.black = mv;
          turns.push(currentTurn);
          currentTurn = { white: null, black: null };
        } else {
          currentTurn.black = mv;
          turns.push(currentTurn);
          currentTurn = { white: null, black: null };
        }
      } else {
        if (currentTurn.white === null) {
          currentTurn.white = mv;
        } else if (currentTurn.black === null) {
          currentTurn.black = mv;
          turns.push(currentTurn);
          currentTurn = { white: null, black: null };
        } else {
          turns.push(currentTurn);
          currentTurn = { white: mv, black: null };
        }
      }
    }

    if (currentTurn.white !== null || currentTurn.black !== null) turns.push(currentTurn);

    let turnNumber = 1;
    for (const t of turns) {
      const div = document.createElement('div');
      div.className = 'move-row';
      const whiteText = t.white ? `<span class="white-move">${t.white.notation}</span>` : `<span class="white-move"></span>`;
      const blackText = t.black ? `<span class="black-move">${t.black.notation}</span>` : `<span class="black-move"></span>`;
      div.innerHTML = `<span class="turn-number">${turnNumber}.</span> ${whiteText} ${blackText}`;
      container.appendChild(div);
      turnNumber++;
    }
  }

  function undoMoveRecord(mv) {
    if (!mv) return;
    const [fr, fc] = mv.from, [tr, tc] = mv.to;

    board[fr][fc] = mv.piece;
    board[tr][tc] = mv.captured || '';

    if (mv.epCaptured) {
      const capRow = mv.piece[0] === 'w' ? tr + 1 : tr - 1;
      board[capRow][tc] = mv.epCaptured;
      board[tr][tc] = '';
    }

    if (mv.rookMove) {
      const [rFromR, rFromC] = mv.rookMove.from;
      const [rToR, rToC] = mv.rookMove.to;
      board[rFromR][rFromC] = board[rToR][rToC];
      board[rToR][rToC] = '';
    }

    enPassantTarget = mv.prevEnPassant ? { row: mv.prevEnPassant.row, col: mv.prevEnPassant.col } : null;
    castleRights = mv.prevCastle ? JSON.parse(JSON.stringify(mv.prevCastle)) : { w: { K: true, Q: true }, b: { K: true, Q: true } };
  }

  function legalMovesFor(r, c) {
    const pseudo = pseudoLegalMovesFor(r, c);
    const legal = [];
    for (const [tr, tc] of pseudo) {
      const piece = board[r][c];
      const isCastle = piece && piece[1] === 'k' && Math.abs(tc - c) === 2;

      if (isCastle && isKingInCheck(piece[0])) continue;

      const mv = doMove(r, c, tr, tc, false);

      let promotedBackup = null;
      if (mv.piece && mv.piece[1] === 'p' && (tr === 0 || tr === 7)) {
        promotedBackup = board[tr][tc];
        board[tr][tc] = mv.piece[0] + 'q';
      }

      let kingInCheck = isKingInCheck(mv.piece[0]);

      if (!kingInCheck && isCastle) {
        const side = (tc - c) > 0 ? 'K' : 'Q';
        const opponent = mv.piece[0] === 'w' ? 'b' : 'w';
        const attacked = squaresAttackedBy(opponent);
        if (side === 'K') {
          if (attacked.has(r + ',' + (c + 1)) || attacked.has(r + ',' + (c + 2))) kingInCheck = true;
        } else {
          if (attacked.has(r + ',' + (c - 1)) || attacked.has(r + ',' + (c - 2))) kingInCheck = true;
        }
      }

      if (promotedBackup !== null) board[tr][tc] = promotedBackup;

      undoMoveRecord(mv);
      if (!kingInCheck) legal.push([tr, tc]);
    }
    return legal;
  }

  function onSquareClick(r, c) {
    if (gameOver) return;
    const clicked = board[r][c];

    if (selected) {
      for (const [lr, lc] of legalMoves) {
        if (lr === r && lc === c) {
          const mv = doMove(selected.r, selected.c, r, c, true);
          sounds.move.currentTime = 0;
          sounds.move.play();

          if (mv.piece && mv.piece[1] === 'k' && Math.abs(mv.to[1] - mv.from[1]) === 2) {
            sounds.castle.currentTime = 0;
            sounds.castle.play();
          }

          // Play capture sound if a piece was captured
          if (mv.captured || mv.epCaptured) {
            sounds.capture.currentTime = 0;
            sounds.capture.play();
          }

          if (mv.captured || mv.epCaptured) {
            sounds.capture.currentTime = 0;
            sounds.capture.play();
          }

          if (mv.captured) captured[mv.piece[0]].push(mv.captured);
          if (mv.epCaptured) captured[mv.piece[0]].push(mv.epCaptured);

          let promotedPiece = null;
          if (mv.piece[1] === 'p' && (r === 0 || r === 7)) {
            let choice = prompt('Promote to (q,r,b,n):', 'q');
            choice = (choice && ['q', 'r', 'b', 'n'].includes(choice.toLowerCase())) ? choice.toLowerCase() : 'q';
            promotedPiece = mv.piece[0] + choice;
            board[r][c] = promotedPiece;
            mv.notation = mv.notation + '=' + choice.toUpperCase();
            mv.promotedPiece = promotedPiece;
            updateMoveHistoryUI();
            sounds.promote.currentTime = 0;
            sounds.promote.play();
          }



          currentPlayer = currentPlayer === 'w' ? 'b' : 'w';
          updateCapturedUI();
          selected = null;
          legalMoves = [];
          render();
          checkGameEnd();
          return;
        }
      }

      if (clicked && clicked[0] === currentPlayer) {
        selectSquare(r, c);
        return;
      }

      selected = null;
      legalMoves = [];
      render();
      return;
    }

    if (clicked && clicked[0] === currentPlayer) {
      selectSquare(r, c);
    }
  }

  function selectSquare(r, c) {
    selected = { r, c, piece: board[r][c] };
    legalMoves = legalMovesFor(r, c);
    render();
  }

  function checkGameEnd() {
    if (moveHistory.length === 1) changeTurnBtn.disabled = true;

    const color = currentPlayer;
    let hasLegalMoves = false;

    for (let r = 0; r < 8 && !hasLegalMoves; r++) {
      for (let c = 0; c < 8 && !hasLegalMoves; c++) {
        const piece = board[r][c];
        if (piece && piece[0] === color && legalMovesFor(r, c).length > 0) {
          hasLegalMoves = true;
        }
      }
    }

    if (!hasLegalMoves) {
      if (isKingInCheck(color)) {
        showResult(`Checkmate! ${color === 'w' ? 'Black' : 'White'} wins!`);
      } else {
        showResult('Stalemate! Game is a draw.');
      }
      gameOver = true;
    }
  }

  function undo() {
    if (!moveHistory.length) return;
    const last = moveHistory.pop();
    undoMoveRecord(last);
    redoStack.push(last);
    rebuildCapturedFromHistory();
    currentPlayer = currentPlayer === 'w' ? 'b' : 'w';
    gameOver = false;
    selected = null;
    legalMoves = [];
    render();
    updateCapturedUI();
    updateStatus();
    updateMoveHistoryUI();
    updateButtonStates();
  }

  function redo() {
    if (!redoStack.length) return;
    const lastRedo = redoStack.pop();
    executeRedoMove(lastRedo);
    selected = null;
    legalMoves = [];
    render();
    checkGameEnd();
  }

  function rebuildCapturedFromHistory() {
    captured = { w: [], b: [] };
    for (const mv of moveHistory) {
      if (mv.captured) captured[mv.piece[0]].push(mv.captured);
      if (mv.epCaptured) captured[mv.piece[0]].push(mv.epCaptured);
    }
  }

  function showResult(text) {
      sounds.gameEnd.currentTime = 0;
      sounds.gameEnd.play();
    resultText.textContent = text;
    resultOverlay.classList.remove('hidden');

    resultCard.style.opacity = '0';
    resultCard.style.transform = 'scale(0.6)';

    let startTime = null;
    const duration = 400;

    function animate(timestamp) {
      if (!startTime) startTime = timestamp;
      const progress = (timestamp - startTime) / duration;

      if (progress < 1) {
        resultCard.style.opacity = Math.min(1, progress * 1.5);
        resultCard.style.transform = `scale(${0.6 + (0.4 * Math.min(1, progress * 1.2))})`;
        requestAnimationFrame(animate);
      } else {
        resultCard.style.opacity = '1';
        resultCard.style.transform = 'scale(1)';
      }
    }

    requestAnimationFrame(animate);
  }

  newGameBtn.addEventListener('click', () => {
    resetState();
    resultOverlay.classList.add('hidden');
  });

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  flipBoardBtn.addEventListener('click', () => {
    boardFlipped = !boardFlipped;
    render();
  });

  changeTurnBtn.addEventListener('click', () => {
    if (moveHistory.length === 0) {
      currentPlayer = currentPlayer === 'w' ? 'b' : 'w';
      updateStatus();
    }
  });

  restartBtn.addEventListener('click', () => {
    resultOverlay.classList.add('hidden');
    resetState();
    render();
    gameOver = false;
  });

  resetState();

  window._chess = {
    getBoard: () => board,
    doMove,
    undoMoveRecord,
    pseudoLegalMovesFor,
    legalMovesFor,
    isKingInCheck
  };
});
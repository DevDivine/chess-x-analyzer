🔗 **Live demo:** https://devdivine.github.io/chess-x-analyzer/

# ♟️ Chess X Analyzer

A browser-based chess project built with **vanilla JavaScript, HTML, and CSS**. It has two parts:

1. **A full chess game** with every rule implemented from scratch.
2. **A game analyzer** that reviews any PGN or FEN with Stockfish and grades every move, in the style of a Chess.com Game Review.

Everything runs in your browser. There is no backend, no account, and no upload; your games never leave your device.

---

## 🔍 Game Analyzer

Paste a PGN or a FEN and get a full review in seconds.

### ✔ Move grading
Moves are graded by **expected points lost** (how much your winning chances dropped), which is the model Chess.com describes for Game Review. A one-pawn slip in an equal position matters far more than the same slip when you're already winning by a mile, and this grading reflects that.

| Label | Meaning |
|---|---|
| **Brilliant** `!!` | A sound piece sacrifice |
| **Great** `!` | The only good move, or a move that changes the outcome |
| **Best** | The engine's top choice |
| **Excellent / Good** | Close to best |
| **Book** | Known opening theory |
| **Forced** | Only one legal move |
| **Inaccuracy** `?!` | A small slip |
| **Mistake** `?` | A clear error |
| **Miss** `×` | The opponent slipped and you didn't punish it |
| **Blunder** `??` | A game-changing error |

### ✔ Accuracy scores
- Separate accuracy for White and Black, shown on ivory and ebony tiles
- Calculated with the open Lichess accuracy formula (volatility-weighted mean combined with a harmonic mean)
- Uses the players' Elo from the PGN (`WhiteElo` / `BlackElo`) when available, because the same advantage converts less reliably at lower ratings

### ✔ Accurate evaluation
- Runs **Stockfish 19 (lite, single-threaded WASM)** locally in a Web Worker
- Searches the top 2 lines per position, so the move you played is compared against the best move from the *same* search
- Checkmates and draws are scored exactly
- Book positions are skipped to save time

### ✔ Opening detection
- Recognizes ~90 opening lines by **position**, so transpositions are handled
- Shows the opening name and ECO code

### ✔ Visuals
- Evaluation graph across the whole game, with markers on blunders, misses, mistakes, brilliancies, and great moves
- Color-coded move list with the classic `!!`, `!`, `?!`, `?`, `??` symbols
- Hover any move to see the expected points lost, the evaluation, and the engine's preferred move
- Per-category breakdown table for both sides
- Single-position mode: paste a FEN to get the evaluation, win percentage, and top engine lines

### ⚡ Speed
- Default depth 14 with a 2-second cap per position
- Optional depth selector (higher depth = closer to Chess.com, but slower)
- A watchdog restarts the engine automatically if a search ever stalls

> **Note:** Accuracy and move labels are a ChessIQ estimate. Chess.com's exact formulas are proprietary, so small differences from an official Game Review are expected, especially for Great and Brilliant moves.

---

## 🎮 Chess Game

### ✔ Full chess logic
- Accurate movement for all pieces
- Check, checkmate & stalemate detection
- Castling (king-side & queen-side)
- En passant capture
- Pawn promotion (Q, R, B, N) with user choice
- Turn-based play

### ✔ Smart move validation
- Generates pseudo-legal moves
- Filters out moves that expose the king
- Validates castling safety squares
- Tracks and restores en passant rights, castle rights, and promotions

### ✔ Move history + notation
- Clean algebraic-style notation, turn by turn (1., 2., 3.…)
- Updates automatically on undo/redo and promotion

### ✔ Undo & redo
- Fully reversible moves
- Restores board state, captures, promotions, castle rights, and en passant status
- Redo stack clears on a new move

### ✔ UI & experience
- Highlights the selected piece, legal squares, and king in check
- Captured pieces display for both sides
- Flip the board anytime
- Animated result popup for wins and draws

### ✔ Sound effects
Move, capture, check, castling, promotion, and game end.

### ✔ Debug helpers (for development)
```js
window._chess.getBoard()
window._chess.doMove(...)
window._chess.undoMoveRecord(...)
window._chess.legalMovesFor(...)
window._chess.isKingInCheck(...)
```

---

## 🛠 Tech Stack
- **Vanilla JavaScript, HTML, CSS**: no frameworks
- **[Stockfish](https://stockfishchess.org/)**: chess engine, running as WebAssembly in a Web Worker
- **[chess.js](https://github.com/jhlywa/chess.js)**: move parsing and validation inside the analyzer
- Audio and PNG pieces for the game UI

## 📂 Project Structure
```
/audio                              → move, capture, check, promote, castle, game-end sounds
/images                             → chess piece PNGs
index.html                          → game page
script.js                           → game logic, rendering, engine
style.css                           → game styles
analyze.js                          → analyzer: Stockfish control, grading, accuracy, UI
analyze.css                         → analyzer theme
stockfish-19-lite-single.js         → Stockfish worker
stockfish-19-lite-single.wasm       → Stockfish engine (must sit next to the .js)
```

## ▶️ Run it locally
The analyzer uses a Web Worker, which browsers block on `file://` pages, so serve the folder over HTTP instead of double-clicking `index.html`:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

On GitHub Pages it works with no extra setup.

## 🎮 How to Play
1. Open the game page
2. Click a piece to highlight its legal moves
3. Click a target square to move
4. Undo or redo anytime, or flip the board
5. Play until checkmate, stalemate, or restart

## 📥 How to Analyze a Game
1. Open the analyzer page
2. Paste a **PGN** (for example from Chess.com or Lichess) or a **FEN**
3. Optionally pick a search depth
4. Click **Analyze game** and wait for the progress bar to finish
5. Read the accuracy tiles, evaluation graph, and move-by-move grades

## 🧩 Future Improvements
- Play against the engine
- Jump from an analyzed move straight to that position on the board
- PGN export
- Move hints and a training mode
- Themes for board and pieces

## 📜 Credits & Licenses
- **Stockfish** is licensed under the [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html). Its source is available at [github.com/official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish).
- **chess.js** is licensed under the BSD 2-Clause license.
- The accuracy formula follows the one published by Lichess; move-grading categories follow the model described in Chess.com's Game Review help pages. This project is not affiliated with either site.

## 💬 About the Project
I started this to challenge myself to build a complete chess system from scratch in vanilla JS, with no frameworks. The game logic, UI, state tracking, and game flow are all handcrafted. The analyzer is the next step: it adds a real engine for deep evaluation while keeping the same everything-in-the-browser approach.

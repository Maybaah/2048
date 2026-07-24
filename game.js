/* 2048 for Maybaah's Arcade.

   Every spawn comes from a seeded generator and every move is appended to a
   tape, so a finished run can be replayed by the leaderboard Worker, which
   recomputes the score itself. The value-level rules here (slide order, merge
   order, spawn choice) must stay identical to the copy in the Worker. */
(function () {
  "use strict";

  var SIZE = 4;
  var N = SIZE * SIZE;
  var MAX_MOVES = 20000;
  var DIRS = ["u", "r", "d", "l"];
  var ANIM_MS = 110;
  var UNDOS = 1;

  /* must match the worker's copy exactly */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomSeed() {
    if (window.crypto && crypto.getRandomValues) {
      return crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return (Math.random() * 4294967296) >>> 0;
  }

  /* line of flat indices for each row/column, ordered from the destination
     edge inward, so sliding always compacts toward index 0 of the line */
  function lines(dir) {
    var out = [], i, j, line;
    for (i = 0; i < SIZE; i++) {
      line = [];
      for (j = 0; j < SIZE; j++) {
        if (dir === "l") line.push(i * SIZE + j);
        else if (dir === "r") line.push(i * SIZE + (SIZE - 1 - j));
        else if (dir === "u") line.push(j * SIZE + i);
        else line.push((SIZE - 1 - j) * SIZE + i);
      }
      out.push(line);
    }
    return out;
  }

  var LINES = { u: lines("u"), r: lines("r"), d: lines("d"), l: lines("l") };

  /* ── state ── */
  var grid;            // 16 slots, each null or a tile object
  var tiles;           // id -> tile {id, v, el}
  var nextId;
  var rnd;
  var seed;
  var moveLog;
  var score, best, moveCount, topTile;
  var over, won, undosLeft;
  var pending = null, settleTimer = null;

  var board = document.getElementById("board");
  var overlay = document.getElementById("overlay");
  var elScore = document.getElementById("s-score");
  var elBest = document.getElementById("s-best");
  var elMoves = document.getElementById("s-moves");
  var elTop = document.getElementById("s-top");
  var elUndo = document.getElementById("btn-undo");

  function posStyle(r, c) {
    return "translate(calc(var(--gap) + " + c + " * (var(--cell) + var(--gap))), " +
           "calc(var(--gap) + " + r + " * (var(--cell) + var(--gap))))";
  }

  function valueClass(v) {
    return v > 2048 ? "vbig" : "v" + v;
  }

  function buildSlots() {
    for (var i = 0; i < N; i++) {
      var s = document.createElement("div");
      s.className = "slot";
      s.style.transform = posStyle(Math.floor(i / SIZE), i % SIZE);
      board.appendChild(s);
    }
  }

  function makeTile(index, v, born) {
    var tile = { id: nextId++, v: v };
    var el = document.createElement("div");
    el.className = "tile " + valueClass(v) + (born ? " born" : "");
    el.textContent = v;
    var pos = posStyle(Math.floor(index / SIZE), index % SIZE);
    el.style.setProperty("--pos", pos);
    el.style.transform = pos;
    tile.el = el;
    tiles[tile.id] = tile;
    board.appendChild(el);
    grid[index] = tile;
    return tile;
  }

  function moveTileTo(tile, index) {
    var pos = posStyle(Math.floor(index / SIZE), index % SIZE);
    tile.el.style.setProperty("--pos", pos);
    tile.el.style.transform = pos;
  }

  function dropTile(tile) {
    if (tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
    delete tiles[tile.id];
  }

  /* The class is dropped and re-added on the next frame so a tile that merges
     twice in a row plays the pop both times. */
  function setTileValue(tile, v, quiet) {
    tile.v = v;
    tile.el.textContent = v;
    tile.el.className = "tile " + valueClass(v);
    if (quiet) return;
    var el = tile.el;
    requestAnimationFrame(function () { el.classList.add("pop"); });
  }

  /* spawn: empty slots in ascending index order, cell drawn first, then value */
  function spawn(born) {
    var empties = [];
    for (var i = 0; i < N; i++) if (!grid[i]) empties.push(i);
    if (!empties.length) return null;
    var index = empties[Math.floor(rnd() * empties.length)];
    var v = rnd() < 0.9 ? 2 : 4;
    return makeTile(index, v, born);
  }

  /* ── the move itself ── */
  function applyMove(dir) {
    var group = LINES[dir];
    var moved = false, gained = 0;
    var plan = [];   // {tile, to, mergeWith}

    for (var g = 0; g < group.length; g++) {
      var line = group[g];
      var seq = [];
      for (var k = 0; k < line.length; k++) {
        var t = grid[line[k]];
        if (t) seq.push({ tile: t, from: line[k] });
      }

      var slot = 0;
      for (var i = 0; i < seq.length; i++) {
        var dest = line[slot];
        if (i + 1 < seq.length && seq[i].tile.v === seq[i + 1].tile.v) {
          var merged = seq[i].tile.v * 2;
          gained += merged;
          plan.push({ tile: seq[i].tile, to: dest, becomes: merged });
          plan.push({ tile: seq[i + 1].tile, to: dest, absorbed: true });
          moved = true;
          i++;
        } else {
          plan.push({ tile: seq[i].tile, to: dest });
          if (seq[i].from !== dest) moved = true;
        }
        slot++;
      }
    }

    if (!moved) return null;

    grid = new Array(N).fill(null);
    for (var p = 0; p < plan.length; p++) {
      var step = plan[p];
      moveTileTo(step.tile, step.to);
      if (!step.absorbed) grid[step.to] = step.tile;
    }
    return { plan: plan, gained: gained };
  }

  /* Swap merged tiles for their sum, drop the absorbed ones and bring in the
     new tile. Runs when the slide animation ends, or straight away if the
     player is already sliding the next move. */
  function applyPlan(plan, quiet) {
    for (var i = 0; i < plan.length; i++) {
      var step = plan[i];
      if (step.absorbed) dropTile(step.tile);
      else if (step.becomes) setTileValue(step.tile, step.becomes, quiet);
    }
  }

  function settle() {
    if (!pending) return;
    var plan = pending.plan;
    pending = null;
    clearTimeout(settleTimer);

    applyPlan(plan);
    spawn(true);
    topTile = highestTile();
    refreshStats();

    if (!won && topTile >= 2048) {
      won = true;
      showOverlay("2048 reached", "score " + score + ". keep going for a bigger tile.", "Keep going");
    } else if (!movesLeft()) {
      endRun();
    }
  }

  function highestTile() {
    var m = 0;
    for (var id in tiles) if (tiles[id].v > m) m = tiles[id].v;
    return m;
  }

  function movesLeft() {
    for (var i = 0; i < N; i++) {
      if (!grid[i]) return true;
      var r = Math.floor(i / SIZE), c = i % SIZE;
      if (c + 1 < SIZE && grid[i + 1] && grid[i + 1].v === grid[i].v) return true;
      if (r + 1 < SIZE && grid[i + SIZE] && grid[i + SIZE].v === grid[i].v) return true;
    }
    return false;
  }

  function showGain(points) {
    var slot = document.getElementById("gain-slot");
    var g = document.createElement("div");
    g.className = "gain";
    g.textContent = "+" + points;
    slot.appendChild(g);
    setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 700);
  }

  function refreshStats() {
    elScore.textContent = score;
    elMoves.textContent = moveCount;
    elTop.textContent = topTile;
    if (score > best) best = score;
    elBest.textContent = best;
    refreshUndo();
  }

  function refreshUndo() {
    elUndo.textContent = undosLeft > 0 ? "Undo (" + undosLeft + ")" : "Undo used";
    elUndo.disabled = over || undosLeft <= 0 || !moveLog.length;
  }

  /* ── the one step back ──
     Nothing here can rewind the generator, so an undo replays the run from its
     own seed with the last move dropped. The tape stays a prefix of the tape
     that was already there, which is exactly what the Worker replays, so the
     board a player lands on is the board the Worker would compute. One per
     run, and only while the run is still going: a jammed board has already
     been scored. */
  function rebuild(tape) {
    board.querySelectorAll(".tile").forEach(function (el) { el.remove(); });
    grid = new Array(N).fill(null);
    tiles = {};
    nextId = 1;
    rnd = mulberry32(seed >>> 0);
    score = 0;
    moveCount = 0;
    moveLog = "";
    spawn(false);
    spawn(false);

    for (var i = 0; i < tape.length; i++) {
      var res = applyMove(tape[i]);
      if (!res) break;
      applyPlan(res.plan, true);
      score += res.gained;
      moveCount++;
      moveLog += tape[i];
      spawn(false);
    }

    topTile = highestTile();
    refreshStats();
  }

  function undo() {
    settle();
    if (over || undosLeft <= 0 || !moveLog.length) return;
    undosLeft--;
    rebuild(moveLog.slice(0, -1));
  }

  function move(dir) {
    settle();
    if (over) return;
    if (moveLog.length >= MAX_MOVES) return;
    var res = applyMove(dir);
    if (!res) return;

    moveLog += dir;
    moveCount++;
    score += res.gained;
    if (res.gained) showGain(res.gained);

    pending = res;
    settleTimer = setTimeout(settle, ANIM_MS);
  }

  function showOverlay(title, sub, buttonLabel) {
    document.getElementById("ov-title").textContent = title;
    document.getElementById("ov-sub").textContent = sub;
    document.getElementById("ov-again").textContent = buttonLabel;
    overlay.classList.add("show");
  }

  function endRun() {
    over = true;
    refreshUndo();
    showOverlay("game over", "no moves left. score " + score + ".", "New game");
    Arcade.addScore("2048", { points: score, maxTile: topTile, moves: moveCount });
    showSubmitUI();
  }

  /* ── submission: the worker replays the tape and scores the run itself ── */
  function showSubmitUI() {
    var input = document.getElementById("run-name");
    var stored = Arcade.getPlayer();
    input.value = stored === "player" ? "" : stored;
    document.getElementById("run-status").textContent = "";
    document.getElementById("btn-submit-run").disabled = false;
    document.getElementById("submit-run").style.display = "flex";
  }

  function submitRun() {
    var input = document.getElementById("run-name");
    var status = document.getElementById("run-status");
    var btn = document.getElementById("btn-submit-run");
    var name = input.value.trim();
    if (!name) {
      status.textContent = "enter a name first";
      input.focus();
      return;
    }
    if (!window.Arcade || !Arcade.submit) return;
    Arcade.setPlayer(name);
    btn.disabled = true;
    status.textContent = "verifying…";
    Arcade.submit("2048", { seed: seed, moves: moveLog }).then(function (res) {
      status.textContent = res && res.rank ? "verified, ranked #" + res.rank : "verified";
    }).catch(function (e) {
      status.textContent = e.message || "submission failed";
      btn.disabled = false;
    });
  }

  /* ── lifecycle ── */
  function newGame() {
    board.querySelectorAll(".tile").forEach(function (el) { el.remove(); });
    grid = new Array(N).fill(null);
    tiles = {};
    nextId = 1;
    seed = randomSeed();
    rnd = mulberry32(seed >>> 0);
    moveLog = "";
    score = 0; moveCount = 0;
    over = false; won = false;
    undosLeft = UNDOS;
    clearTimeout(settleTimer);
    pending = null;
    overlay.classList.remove("show");
    document.getElementById("submit-run").style.display = "none";

    spawn(true);
    spawn(true);
    topTile = highestTile();
    refreshStats();
  }

  function storedBest() {
    var runs = Arcade.getScores("2048");
    var m = 0;
    for (var i = 0; i < runs.length; i++) if (runs[i].points > m) m = runs[i].points;
    return m;
  }

  /* ── input ── */
  var KEYS = {
    ArrowUp: "u", ArrowRight: "r", ArrowDown: "d", ArrowLeft: "l",
    w: "u", d: "r", s: "d", a: "l", W: "u", D: "r", S: "d", A: "l"
  };

  // physical key positions, so WASD works on any keyboard layout
  var CODES = {
    ArrowUp: "u", ArrowRight: "r", ArrowDown: "d", ArrowLeft: "l",
    KeyW: "u", KeyD: "r", KeyS: "d", KeyA: "l"
  };

  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.code === "KeyZ" || e.key === "z" || e.key === "Z") {
      e.preventDefault();
      undo();
      return;
    }
    var dir = KEYS[e.key] || CODES[e.code];
    if (!dir) return;
    e.preventDefault();
    move(dir);
  });

  var touchX = null, touchY = null;
  board.addEventListener("touchstart", function (e) {
    var t = e.changedTouches[0];
    touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  board.addEventListener("touchend", function (e) {
    if (touchX === null) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = null;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "r" : "l") : (dy > 0 ? "d" : "u"));
  }, { passive: true });

  board.addEventListener("animationend", function (e) {
    e.target.classList.remove("pop", "born");
  });

  document.getElementById("btn-new").addEventListener("click", newGame);
  elUndo.addEventListener("click", undo);
  document.getElementById("ov-again").addEventListener("click", function () {
    if (over) newGame();
    else overlay.classList.remove("show");
  });
  document.getElementById("btn-submit-run").addEventListener("click", submitRun);
  document.getElementById("run-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitRun();
  });

  buildSlots();
  best = storedBest();
  newGame();

  /* exposed for the staging checks */
  window.__2048 = {
    move: move,
    settle: settle,
    undo: undo,
    state: function () {
      return {
        seed: seed, moves: moveLog, score: score, top: topTile,
        over: over, undos: undosLeft, grid: grid.map(function (t) { return t ? t.v : 0; })
      };
    },
    dirs: DIRS
  };
})();

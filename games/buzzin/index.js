import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load questions from category files
function loadAllQuestions() {
  const categoriesDir = path.join(__dirname, "categories");
  const questions = [];

  // Category name mapping (filename to display name)
  const categoryNames = {
    "general-knowledge": "General Knowledge",
    "science": "Science",
    "movies-tv": "Movies & TV",
    "music": "Music",
    "sports": "Sports",
    "history": "History",
    "geography": "Geography",
    "pop-culture": "Pop Culture",
    "games": "Games",
    "random": "Random"
  };

  try {
    const files = fs.readdirSync(categoriesDir);

    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(categoriesDir, file);
        const categoryKey = file.replace(".json", "");
        const categoryName = categoryNames[categoryKey] || categoryKey;

        try {
          const fileContents = fs.readFileSync(filePath, "utf-8");
          const categoryQuestions = JSON.parse(fileContents);

          // Add category to each question
          for (const q of categoryQuestions) {
            questions.push({
              ...q,
              category: categoryName
            });
          }
        } catch (parseError) {
          console.error(`Error loading ${file}:`, parseError.message);
        }
      }
    }
  } catch (dirError) {
    console.error("Error reading categories directory:", dirError.message);
  }

  return questions;
}

const allQuestions = loadAllQuestions();
console.log(`[BuzzIn] Loaded ${allQuestions.length} questions from ${new Set(allQuestions.map(q => q.category)).size} categories`);

// Unbiased Fisher-Yates shuffle — returns a new shuffled array
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Fuzzy answer matching (case-insensitive, word-order independent, plural/typo tolerant)
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] :
        1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Map number words to digits so "six" matches "6" but "five" never matches "6"
const NUMBER_WORDS = {
  "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
  "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
  "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
  "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
  "eighteen": "18", "nineteen": "19", "twenty": "20", "thirty": "30",
  "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70",
  "eighty": "80", "ninety": "90", "hundred": "100", "thousand": "1000"
};

function normalizeNumbers(s) {
  let result = s;
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, "g"), digit);
  }
  return result;
}

// Returns true if the string (after spaces removed) is purely numeric
const isPureNumber = (s) => /^\d+$/.test(s.replace(/\s+/g, ""));

function fuzzyMatch(userAnswer, correctAnswer) {
  if (!userAnswer || !correctAnswer) return false;
  const norm = (s) => s.toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
  const a = norm(userAnswer);
  const b = norm(correctAnswer);

  if (a === b) return true;

  // Normalize number words to digits for both strings
  const aN = normalizeNumbers(a);
  const bN = normalizeNumbers(b);

  // If either side is a pure number after normalization, require exact digit match.
  // This prevents "five" matching "6" and allows "six" matching "6".
  if (isPureNumber(aN) || isPureNumber(bN)) {
    return aN.replace(/\s+/g, "") === bN.replace(/\s+/g, "");
  }

  if (aN === bN) return true;

  // Word-order independent
  const sortW = (s) => s.split(" ").filter(w => w).sort().join(" ");
  if (sortW(a) === sortW(b) || sortW(aN) === sortW(bN)) return true;

  // Remove filler words
  const noFill = (s) => s.split(" ")
    .filter(w => !["the", "a", "an", "of", "in", "at", "to", "and"].includes(w))
    .join(" ");
  const ac = noFill(a), bc = noFill(b);
  if (ac === bc || sortW(ac) === sortW(bc)) return true;

  // Simple stemming: remove trailing s/es/ies
  const stem = (s) => s.replace(/ies\b/g, "y").replace(/es\b/g, "").replace(/s\b/g, "");
  if (stem(ac) === stem(bc) || sortW(stem(ac)) === sortW(stem(bc))) return true;

  // Levenshtein with smart length-proportional thresholds.
  // Very short strings (≤ 4): no fuzzy (too many false positives with short words).
  // Medium (5–7): allow 1 edit.
  // Longer (8–10): allow 2 edits.
  // Long (≥ 11): allow ceil(length / 3) edits (~33% tolerance — handles "Ratouilite" vs "Ratatouille").
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 4) return false;
  if (maxLen <= 7) return levenshtein(a, b) <= 1;
  if (maxLen <= 10) return levenshtein(a, b) <= 2;
  const dist = levenshtein(a, b);
  const allowed = Math.ceil(maxLen / 3);
  // Also try with filler words removed in case the extra words inflate the distance
  const maxLenClean = Math.max(ac.length, bc.length);
  const allowedClean = Math.ceil(maxLenClean / 3);
  return dist <= allowed || (maxLenClean > 4 && levenshtein(ac, bc) <= allowedClean);
}

export default {
  id: "buzzin",
  name: "LOCK IN Trivia",
  description: "Race to buzz in, answer correctly, and sabotage the peeps.",
  minPlayers: 2,
  maxPlayers: 16,
  icon: "💡🦦",

  create({ io, room, roomManager }) {
    // Game State
    let phase = "lobby"; // lobby, countdown, waiting, question, result, end
    let questions = [];
    let currentQuestionIndex = -1;
    let scores = new Map(); // socketId -> number
    let scoresByName = new Map(); // playerName -> number (for reconnection)
    let countdownInterval = null; // Countdown timer
    let countdownSeconds = 0;
    let gameSettings = null; // Store categories and question count

    // New state for "everyone answers" mechanic
    let playerAnswers = new Map(); // socketId -> { answer, timestamp, buzzedAt, isCorrect }
    let disconnectedTracker = new Map(); // nameLower -> { name, disconnectedAt } — for host display
    let timerDuration = 30; // 5-120 seconds, host configurable
    let questionTimer = null;
    let questionStartTime = null;
    let timerRemaining = 0
    let activeTimerDuration = 30; // Timer duration for the current question (may differ for OFF THE DOME)
    let timerRemainingAtPause = 0; // Timer remaining when game was paused
    let firstBonusEnabled = true; // Whether first correct answer gets +50 bonus
    let hostAsPlayer = true; // Whether the host participates as a player (false = spectate/admin only)
    let offTheDomeCount = 3; // Number of final "OFF THE DOME" free-text questions

    // Initialize scores for existing players
    room.players.forEach((p) => {
      if (p.socketId && p.name) {
        scores.set(p.socketId, 0);
        scoresByName.set(p.name.toLowerCase(), 0);
      }
    });

    // Listen for new players joining and initialize/restore their scores.
    // Always checks scoresByName first so reconnects with any socketId are safe.
    const checkAndAddPlayer = (socketId) => {
      const player = room.players.get(socketId);
      if (!player) return;

      // Don't track scores for spectating host
      if (!hostAsPlayer && player.isHost) return;

      // Already tracked under this socketId — nothing to do
      if (scores.has(socketId)) return;

      const playerName = player.name;
      const nameLower = playerName?.toLowerCase();

      // Restore from name-based backup if available (covers reconnects with new socketId)
      if (nameLower && scoresByName.has(nameLower)) {
        const savedScore = scoresByName.get(nameLower);
        scores.set(socketId, savedScore);
        logInfo(`Restored score ${savedScore} for player ${playerName} (socketId: ${socketId})`);
        return;
      }

      // Truly new player — initialize at 0
      scores.set(socketId, 0);
      if (nameLower) {
        scoresByName.set(nameLower, 0);
      }
    };

    // Helper to update both scores maps atomically so they never diverge.
    // Falls back to roomManager names for players who disconnected mid-round.
    const updateScoreByName = (socketId, score, knownName = null) => {
      scores.set(socketId, score);
      const name = knownName
        || room.players.get(socketId)?.name
        || roomManager.getPlayerName(socketId);
      if (name) {
        scoresByName.set(name.toLowerCase(), score);
      }
    };

    // Import logger for reconnection logging
    const logInfo = (msg) => console.log(`[BuzzIn] ${msg}`);

    // Helper: check if socketId is the current host (handles reconnect where hostSocketId may be stale)
    function isHostSocket(socketId) {
      if (socketId === room.hostSocketId) return true;
      const player = room.players.get(socketId);
      if (player?.isHost) {
        room.hostSocketId = socketId; // Fix stale reference after reconnect
        return true;
      }
      return false;
    }

    // --- Helper Functions ---

    function broadcastState() {
      const currentQ =
        currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
          ? questions[currentQuestionIndex]
          : null;

      // Determine if this is an "OFF THE DOME" question (last 3 questions are typing-based)
      const isOffTheDome = currentQuestionIndex >= 0 &&
        (questions.length - currentQuestionIndex) <= offTheDomeCount;

      // Get all players from room to ensure we have valid names
      const roomPlayers = Array.from(room.players.values());

      // When host is spectating, exclude them from participating player lists
      const participatingPlayers = hostAsPlayer
        ? roomPlayers.filter(p => p.socketId)
        : roomPlayers.filter(p => p.socketId && !p.isHost);

      // Build player buzz/answer status (show who buzzed, but hide answers)
      const playerBuzzStatus = participatingPlayers.map(p => {
        const answerData = playerAnswers.get(p.socketId);
        return {
          socketId: p.socketId,
          name: p.name || roomManager.getPlayerName(p.socketId) || `Player-${p.socketId.slice(0, 4)}`,
          hasBuzzed: !!answerData,
          hasAnswered: !!(answerData?.answer !== undefined)
        };
      });

      // Check if this is the first OFF THE DOME question (show announcement)
      const isFirstOffTheDome = isOffTheDome &&
        currentQuestionIndex === questions.length - offTheDomeCount;

      const state = {
        phase,
        hostAsPlayer,
        offTheDomeCount,
        currentQuestion: currentQ ? {
          ...currentQ,
          // Only include choices if NOT an OFF THE DOME question
          choices: isOffTheDome ? null : (currentQ.choices || null)
        } : null,
        currentQuestionIndex,
        totalQuestions: questions.length,
        countdownSeconds: phase === "countdown" ? countdownSeconds : null,
        // Timer state
        timerRemaining,
        timerDuration: activeTimerDuration,
        // OFF THE DOME state
        isOffTheDome,
        isFirstOffTheDome,
        // Answer tracking
        answeredCount: Array.from(playerAnswers.values()).filter(a => a.answer !== undefined).length,
        totalPlayers: participatingPlayers.length,
        playerBuzzStatus,
        // Scores — exclude spectating host
        scores: Array.from(scores.entries()).map(([id, score]) => {
          const roomPlayer = roomPlayers.find(p => p.socketId === id);
          const name = roomPlayer?.name || roomManager.getPlayerName(id) || `Player-${id.slice(0, 4)}`;
          return {
            socketId: id,
            name: name,
            score: score
          };
        }),
        // Players currently disconnected (for host between-question display)
        disconnectedPlayers: Array.from(disconnectedTracker.values())
      };

      io.to(room.code).emit("game:state", state);
    }

    function nextQuestion() {
      // Clear any existing timer
      stopQuestionTimer();

      // Clear answer state
      playerAnswers.clear();

      currentQuestionIndex++;

      if (currentQuestionIndex >= questions.length) {
        endGame();
        return;
      }

      // First show "waiting" phase - host must click "Show Question"
      phase = "waiting";
      timerRemaining = timerDuration;

      // Initialize scores for any mid-game joiners using checkAndAddPlayer so
      // reconnects are restored from scoresByName rather than zeroed.
      room.players.forEach((p) => {
        if (p.socketId) checkAndAddPlayer(p.socketId);
      });

      broadcastState();
    }

    function showQuestion() {
      if (phase !== "waiting") return;

      phase = "question";
      playerAnswers.clear(); // Reset answers for new question

      // OFF THE DOME questions get at least 60 seconds regardless of slider
      const isOTD = currentQuestionIndex >= 0 &&
        (questions.length - currentQuestionIndex) <= offTheDomeCount;
      const effectiveTimer = isOTD ? Math.max(60, timerDuration) : timerDuration;

      startQuestionTimer(effectiveTimer);

      io.to(room.code).emit("game:event", { type: "question_shown" });
      broadcastState();
    }

    // --- Timer Functions ---

    function startQuestionTimer(customDuration, startingRemaining) {
      activeTimerDuration = customDuration !== undefined ? customDuration : timerDuration;
      const startRemaining = startingRemaining !== undefined ? startingRemaining : activeTimerDuration;
      // Set questionStartTime so elapsed time = (activeTimerDuration - startRemaining)
      questionStartTime = Date.now() - (activeTimerDuration - startRemaining) * 1000;
      timerRemaining = startRemaining;

      questionTimer = setInterval(() => {
        timerRemaining = Math.max(0, activeTimerDuration - Math.floor((Date.now() - questionStartTime) / 1000));
        broadcastState();

        if (timerRemaining <= 0) {
          clearInterval(questionTimer);
          questionTimer = null;
          endAnsweringPhase();
        }
      }, 1000);
    }

    function stopQuestionTimer() {
      if (questionTimer) {
        clearInterval(questionTimer);
        questionTimer = null;
      }
    }

    function checkAllAnswered() {
      // Check if all participating players have submitted answers (exclude spectating host)
      const activePlayers = Array.from(room.players.values()).filter(p =>
        p.socketId && (hostAsPlayer || !p.isHost)
      );
      const answeredPlayers = Array.from(playerAnswers.values()).filter(a => a.answer !== undefined);

      if (answeredPlayers.length >= activePlayers.length && activePlayers.length > 0) {
        stopQuestionTimer();
        endAnsweringPhase();
      }
    }

    function endAnsweringPhase(skipPoints = false) {
      // Guard against double-fire from simultaneous timer expiry + checkAllAnswered
      if (phase !== "question" && phase !== "paused") return;
      phase = "result";

      // Calculate scores based on answers
      const currentQ = questions[currentQuestionIndex];
      const correctAnswer = currentQ?.answer?.toLowerCase().trim();

      // Only use fuzzy matching for OFF THE DOME (free-text) questions;
      // multiple choice answers must match exactly since options are concrete.
      const isOTD = currentQuestionIndex >= 0 &&
        (questions.length - currentQuestionIndex) <= offTheDomeCount;

      // Find first correct answer by timestamp
      let firstCorrectId = null;
      let firstCorrectTime = Infinity;
      let firstBuzzTime = Infinity;

      // First pass: determine correctness and find first correct
      playerAnswers.forEach((data, socketId) => {
        const playerAnswer = data.answer?.toLowerCase().trim();
        const isCorrect = isOTD
          ? fuzzyMatch(playerAnswer || "", correctAnswer || "")
          : (playerAnswer === correctAnswer);
        data.isCorrect = isCorrect;

        if (isCorrect && data.timestamp) {
          // Use timestamp as primary, buzzedAt as tiebreaker
          if (data.timestamp < firstCorrectTime ||
              (data.timestamp === firstCorrectTime && data.buzzedAt < firstBuzzTime)) {
            firstCorrectTime = data.timestamp;
            firstBuzzTime = data.buzzedAt;
            firstCorrectId = socketId;
          }
        }
      });

      // Second pass: award points
      const results = [];
      playerAnswers.forEach((data, socketId) => {
        const roomPlayer = room.players.get(socketId);
        // data.playerName is set at buzz/submit time and survives if the player disconnects
        const playerName = data.playerName
          || roomPlayer?.name
          || roomManager.getPlayerName(socketId)
          || `Player-${socketId.slice(0, 4)}`;

        let points = 0;
        let eventType = null;

        if (data.isCorrect && !skipPoints) {
          if (socketId === firstCorrectId && firstBonusEnabled) {
            points = 150; // First correct bonus (+50)
            eventType = "first_correct";
          } else {
            points = 100; // Standard correct
            eventType = socketId === firstCorrectId ? "first_correct" : "correct";
          }
          // Fall back to scoresByName if player disconnected (scores map entry deleted on disconnect)
          const nameLower = playerName.toLowerCase();
          const oldScore = scores.get(socketId) ?? scoresByName.get(nameLower) ?? 0;
          updateScoreByName(socketId, oldScore + points, playerName);
        }
        // Wrong or no answer = 0 points (no penalty)

        results.push({
          socketId,
          name: playerName,
          answer: data.answer || "(No answer)",
          isCorrect: data.isCorrect || false,
          isFirstCorrect: socketId === firstCorrectId,
          points,
          buzzedAt: data.buzzedAt
        });

        // Emit individual events for animations
        if (eventType) {
          io.to(room.code).emit("game:event", {
            type: eventType,
            playerId: socketId,
            points
          });
        }
      });

      // Emit round results with all answers revealed
      io.to(room.code).emit("game:event", {
        type: "round_results",
        correctAnswer: currentQ?.answer,
        results: results.sort((a, b) => (b.isFirstCorrect ? 1 : 0) - (a.isFirstCorrect ? 1 : 0))
      });

      broadcastState();
    }

    function startCountdown() {
      // Clear any existing countdown interval (guard against double-start on rapid restart)
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      countdownSeconds = 10;
      phase = "countdown";
      broadcastState();
      
      countdownInterval = setInterval(() => {
        countdownSeconds--;
        broadcastState();
        
        if (countdownSeconds <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
          // Move to first question
          currentQuestionIndex = -1;
          nextQuestion();
        }
      }, 1000);
    }
    
    function endGame(reason = "ended") {
      // Clear all timers
      stopQuestionTimer();
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }

      // Clear disconnect display — game is over, no longer relevant
      disconnectedTracker.clear();

      phase = "end";
      broadcastState();

      io.to(room.code).emit("game:event", {
        type: "game_ended",
        reason: reason
      });
    }

    return {
      // --- Socket Event Handler ---
      handleEvent({ eventName, payload, socketId }) {
        // Ensure player exists and has a score entry
        checkAndAddPlayer(socketId);

        switch (eventName) {
          case "host:startGame":
            if (!isHostSocket(socketId)) return;
            if (phase !== "lobby") return; // Can only start from lobby

            // Read hostAsPlayer setting (default true = host participates)
            hostAsPlayer = payload?.hostAsPlayer !== false;

            {
              // Validate minimum players
              // If host is spectating, need at least 2 real players; otherwise host + 1 suffices
              const nonHostCount = Array.from(room.players.values()).filter(p => !p.isHost).length;
              const minNeeded = hostAsPlayer ? 1 : 2;
              if (nonHostCount < minNeeded) {
                io.to(socketId).emit("game:event", {
                  type: "error",
                  message: hostAsPlayer
                    ? "Need at least 2 players to start"
                    : "Need at least 2 players (besides the host) to start in spectate mode"
                });
                return;
              }
            }
            
            // Filter questions by selected categories
            const selectedCategories = payload?.categories || [];
            if (selectedCategories.length === 0) {
              io.to(socketId).emit("game:event", {
                type: "error",
                message: "Please select at least one category"
              });
              return;
            }
            
            // Store settings for restart (including timer duration)
            timerDuration = Math.max(5, Math.min(120, payload?.timerDuration || 30));
            firstBonusEnabled = payload?.bonusFirstCorrect !== false;
            // offTheDomeCount is clamped after questions are selected (see below)
            gameSettings = {
              categories: selectedCategories,
              questionCount: payload?.questionCount || 10,
              timerDuration: timerDuration,
              bonusFirstCorrect: firstBonusEnabled,
              offTheDomeCount: payload?.offTheDomeCount ?? 3
            };
            
            let filteredQuestions = allQuestions.filter(q =>
              selectedCategories.includes(q.category)
            );

            // Filter out questions seen in previous games this session
            const seenQs = payload?.seenQuestions || [];
            if (seenQs.length > 0) {
              const filtered = filteredQuestions.filter(q => !seenQs.includes(q.question));
              // Only use filter if enough questions remain (at least 5)
              if (filtered.length >= 5) filteredQuestions = filtered;
            }

            // Ensure at least 5 questions are available
            if (filteredQuestions.length < 5) {
              io.to(socketId).emit("game:event", {
                type: "error",
                message: `Not enough questions in selected categories (found ${filteredQuestions.length}). Please select more categories.`
              });
              return;
            }

            // Cap at actual available count (no arbitrary limit)
            const requestedCount = Math.min(
              Math.max(5, gameSettings.questionCount),
              filteredQuestions.length
            );
            
            // Shuffle and select questions (Fisher-Yates for unbiased randomness)
            questions = shuffle(filteredQuestions).slice(0, requestedCount);

            // Clamp offTheDomeCount to actual question count
            offTheDomeCount = Math.max(0, Math.min(gameSettings.offTheDomeCount, questions.length));

            if (questions.length === 0) {
              // Fallback to all questions if filtered result is empty
              questions = shuffle(allQuestions).slice(0, Math.min(10, allQuestions.length));
            }
            
            // Initialize scores — skip host if spectating
            scores.clear();
            scoresByName.clear();
            disconnectedTracker.clear();
            room.players.forEach((p) => {
              if (p.socketId && (hostAsPlayer || !p.isHost)) {
                scores.set(p.socketId, 0);
                if (p.name) scoresByName.set(p.name.toLowerCase(), 0);
              }
            });

            // Start countdown
            startCountdown();
            break;
            
          case "host:restartGame":
            if (!isHostSocket(socketId)) return;
            if (!gameSettings) {
              io.to(socketId).emit("game:event", {
                type: "error",
                message: "Cannot restart: no game settings found"
              });
              return;
            }

            // Reset game state
            currentQuestionIndex = -1;
            phase = "lobby";
            playerAnswers.clear();
            stopQuestionTimer();
            if (countdownInterval) {
              clearInterval(countdownInterval);
              countdownInterval = null;
            }

            // Update settings if new ones provided by play-again modal
            if (payload.categories?.length > 0) gameSettings.categories = payload.categories;
            if (payload.questionCount) gameSettings.questionCount = payload.questionCount;
            if (payload.timerDuration) {
              timerDuration = payload.timerDuration;
              gameSettings.timerDuration = payload.timerDuration;
            } else {
              timerDuration = gameSettings.timerDuration || 30;
            }
            if (payload.bonusFirstCorrect !== undefined) {
              firstBonusEnabled = payload.bonusFirstCorrect !== false;
              gameSettings.bonusFirstCorrect = firstBonusEnabled;
            } else {
              firstBonusEnabled = gameSettings.bonusFirstCorrect !== false;
            }
            if (payload.offTheDomeCount !== undefined) {
              gameSettings.offTheDomeCount = payload.offTheDomeCount;
            }
            activeTimerDuration = timerDuration;

            // Reset all scores — skip host if spectating
            scores.clear();
            scoresByName.clear();
            disconnectedTracker.clear();
            room.players.forEach((p) => {
              if (p.socketId && (hostAsPlayer || !p.isHost)) {
                scores.set(p.socketId, 0);
                if (p.name) scoresByName.set(p.name.toLowerCase(), 0);
              }
            });
            
            // Re-randomize questions with same settings
            let filteredQuestionsRestart = allQuestions.filter(q =>
              gameSettings.categories.includes(q.category)
            );

            // Filter out seen questions
            const seenQsRestart = payload?.seenQuestions || [];
            if (seenQsRestart.length > 0) {
              const f = filteredQuestionsRestart.filter(q => !seenQsRestart.includes(q.question));
              if (f.length >= 5) filteredQuestionsRestart = f;
            }

            questions = shuffle(filteredQuestionsRestart)
              .slice(0, Math.min(gameSettings.questionCount, filteredQuestionsRestart.length));

            // Clamp offTheDomeCount to actual question count
            offTheDomeCount = Math.max(0, Math.min(gameSettings.offTheDomeCount ?? 3, questions.length));

            // Start countdown again
            startCountdown();
            break;
            
          case "host:endGame":
            if (!isHostSocket(socketId)) return;
            endGame("ended_by_host");
            break;

          case "host:showQuestion":
            if (!isHostSocket(socketId)) return;
            if (phase === "waiting") {
              showQuestion();
            }
            break;

          case "host:nextQuestion":
            if (!isHostSocket(socketId)) return;
            if (phase === "result") {
              nextQuestion();
            }
            break;

          case "host:skipRound":
            if (!isHostSocket(socketId)) return;
            if (phase !== "question" && phase !== "result" && phase !== "paused") return;

            stopQuestionTimer();

            if (phase === "question" || phase === "paused") {
              // Skip without awarding points (also handles skipping a paused round)
              endAnsweringPhase(true);
            }

            // Emit skip event
            io.to(room.code).emit("game:event", {
              type: "round_skipped"
            });
            break;

          case "host:shuffleQuestions":
            if (!isHostSocket(socketId)) return;
            if (phase === "lobby" || phase === "countdown") return;

            {
              const alreadyAsked = questions.slice(0, currentQuestionIndex);
              const currentQ = questions[currentQuestionIndex];
              const notYetAsked = questions.slice(currentQuestionIndex + 1);

              if (phase === "result") {
                // Current question is already done — only shuffle UPCOMING questions.
                // Never put the finished question back into the pool.
                if (notYetAsked.length === 0) {
                  // Nothing left to reorder; still emit the event so the client toasts.
                  io.to(room.code).emit("game:event", {
                    type: "questions_shuffled",
                    message: "Questions reshuffled!"
                  });
                  break;
                }
                questions = [...alreadyAsked, currentQ, ...shuffle(notYetAsked)];
                io.to(room.code).emit("game:event", {
                  type: "questions_shuffled",
                  message: "Questions reshuffled!"
                });
                broadcastState();
              } else {
                // In waiting / question / paused phase — current question has NOT been
                // answered yet, so include it in the shuffle pool and swap to a new one.
                stopQuestionTimer();
                playerAnswers.clear();

                if (notYetAsked.length === 0) {
                  // Last question — no alternatives, just reset to waiting for re-show.
                  phase = "waiting";
                  io.to(room.code).emit("game:event", {
                    type: "questions_shuffled",
                    message: "Questions reshuffled!"
                  });
                  broadcastState();
                } else {
                  // Shuffle current + remaining, guaranteeing a different question first.
                  const combinedPool = shuffle([currentQ, ...notYetAsked]);
                  if (combinedPool[0].question === currentQ.question) {
                    const swapIdx = Math.floor(Math.random() * (combinedPool.length - 1)) + 1;
                    [combinedPool[0], combinedPool[swapIdx]] = [combinedPool[swapIdx], combinedPool[0]];
                  }

                  questions = [...alreadyAsked, ...combinedPool];
                  currentQuestionIndex--; // nextQuestion() will increment back
                  nextQuestion();         // phase = "waiting", timer reset on Show Question

                  io.to(room.code).emit("game:event", {
                    type: "questions_shuffled",
                    message: "Questions reshuffled!"
                  });
                }
              }
            }
            break;

          case "host:pauseGame":
            if (!isHostSocket(socketId)) return;
            if (phase !== "question") return;
            // Save remaining time and stop timer
            timerRemainingAtPause = timerRemaining;
            stopQuestionTimer();
            phase = "paused";
            io.to(room.code).emit("game:event", { type: "game_paused" });
            broadcastState();
            break;

          case "host:resumeGame":
            if (!isHostSocket(socketId)) return;
            if (phase !== "paused") return;
            phase = "question";
            // Resume timer from where it was paused
            startQuestionTimer(activeTimerDuration, timerRemainingAtPause);
            io.to(room.code).emit("game:event", { type: "game_resumed" });
            broadcastState();
            break;

          case "player:buzz":
            // In new flow: Everyone can buzz to indicate they want to answer
            if (phase !== "question") {
              return; // Silently ignore if not in question phase
            }

            // Check if player exists in room (host is also a player)
            if (!room.players.has(socketId)) {
              return; // Player not in room
            }

            // Block spectating host from buzzing
            if (!hostAsPlayer && isHostSocket(socketId)) {
              return;
            }

            // Check if player already buzzed
            if (playerAnswers.has(socketId)) {
              return; // Already buzzed, ignore
            }

            // Record buzz timestamp — store name now so it survives if player disconnects before round ends
            playerAnswers.set(socketId, {
              playerName: room.players.get(socketId)?.name || roomManager.getPlayerName(socketId) || null,
              answer: undefined,
              timestamp: null,
              buzzedAt: Date.now(),
              isCorrect: false
            });

            const buzzerName = room.players.get(socketId)?.name ||
              roomManager.getPlayerName(socketId) ||
              `Player-${socketId.slice(0, 4)}`;

            io.to(room.code).emit("game:event", {
              type: "player_buzzed",
              playerId: socketId,
              playerName: buzzerName
            });

            broadcastState();
            break;
            
          case "player:submitAnswer":
            // In new flow: Any player can submit their answer
            if (phase !== "question") {
              return; // Wrong phase
            }

            // Check if player exists in room
            if (!room.players.has(socketId)) {
              return;
            }

            // Block spectating host from submitting answers
            if (!hostAsPlayer && isHostSocket(socketId)) {
              return;
            }

            const existingData = playerAnswers.get(socketId);

            if (!existingData) {
              // Player hasn't buzzed yet - auto-buzz and submit in one action, store name now
              playerAnswers.set(socketId, {
                playerName: room.players.get(socketId)?.name || roomManager.getPlayerName(socketId) || null,
                answer: payload?.answer || "",
                timestamp: Date.now(),
                buzzedAt: Date.now(),
                isCorrect: false
              });
            } else if (existingData.answer === undefined) {
              // Player buzzed but hasn't answered yet
              existingData.answer = payload?.answer || "";
              existingData.timestamp = Date.now();
            } else {
              // Already answered - ignore
              return;
            }

            io.to(room.code).emit("game:event", {
              type: "player_answered",
              playerId: socketId
            });

            broadcastState();
            checkAllAnswered();
            break;

          case "host:overrideScore":
             if (!isHostSocket(socketId)) return;
             // payload: { playerId, delta }
             if (payload.playerId && typeof payload.delta === 'number') {
                 const targetPlayer = room.players.get(payload.playerId);
                 const current = scores.get(payload.playerId)
                   ?? (targetPlayer?.name ? scoresByName.get(targetPlayer.name.toLowerCase()) : undefined)
                   ?? 0;
                 updateScoreByName(payload.playerId, current + payload.delta);
                 broadcastState();
             }
             break;
             
          case "player:joined":
            // checkAndAddPlayer already ran at the top of handleEvent.
            // Calling it again is safe — it's a no-op if the score is already set.
            checkAndAddPlayer(socketId);

            // Remove from disconnected tracker now that they've rejoined
            {
              const rejoiningPlayer = room.players.get(socketId);
              if (rejoiningPlayer?.name) {
                disconnectedTracker.delete(rejoiningPlayer.name.toLowerCase());
              }
            }

            // Broadcast state so the new player gets it
            broadcastState();

            if (payload?.isReconnecting) {
              const player = room.players.get(socketId);
              io.to(room.code).emit("game:event", {
                type: "player_reconnected",
                playerName: player?.name || "Player",
                playerId: socketId
              });
            }
            break;

          case "player:disconnected": {
            // Handle player disconnection mid-game.
            // IMPORTANT: room.players no longer contains this socket (removed before this event fires).
            // The socketHandlers passes playerName in the payload as a fallback.
            const disconnectedPlayer = room.players.get(socketId);
            const disconnectedName = disconnectedPlayer?.name || payload?.playerName;
            if (disconnectedName) {
              const currentScore = scores.get(socketId) || 0;
              scoresByName.set(disconnectedName.toLowerCase(), currentScore);
              logInfo(`Saved score ${currentScore} for disconnected player ${disconnectedName}`);
              // Track for host display
              disconnectedTracker.set(disconnectedName.toLowerCase(), {
                name: disconnectedName,
                disconnectedAt: Date.now()
              });
            }

            // Only remove from playerAnswers if they haven't answered yet.
            // If they already submitted an answer, keep it so endAnsweringPhase
            // can still award their points when the round ends.
            const existingAnswer = playerAnswers.get(socketId);
            if (!existingAnswer || existingAnswer.answer === undefined) {
              playerAnswers.delete(socketId);
            }
            scores.delete(socketId);

            // Notify others of disconnection
            io.to(room.code).emit("game:event", {
              type: "player_disconnected",
              playerName: disconnectedName || "Player"
            });

            // Check if all remaining players have answered
            if (phase === "question") {
              checkAllAnswered();
            }
            broadcastState();
            break;
          }
        }
      },

      getState() {
        const roomPlayers = Array.from(room.players.values());
        const participatingPlayers = hostAsPlayer
          ? roomPlayers.filter(p => p.socketId)
          : roomPlayers.filter(p => p.socketId && !p.isHost);

        // Build player buzz/answer status
        const playerBuzzStatus = participatingPlayers.map(p => {
          const answerData = playerAnswers.get(p.socketId);
          return {
            socketId: p.socketId,
            name: p.name || roomManager.getPlayerName(p.socketId) || `Player-${p.socketId.slice(0, 4)}`,
            hasBuzzed: !!answerData,
            hasAnswered: !!(answerData?.answer !== undefined)
          };
        });

        // Determine if OFF THE DOME
        const isOffTheDome = currentQuestionIndex >= 0 &&
          (questions.length - currentQuestionIndex) <= offTheDomeCount;
        const isFirstOffTheDome = isOffTheDome &&
          currentQuestionIndex === questions.length - offTheDomeCount;

        const currentQ = currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
          ? questions[currentQuestionIndex]
          : null;

        return {
          phase,
          hostAsPlayer,
          offTheDomeCount,
          countdownSeconds: phase === "countdown" ? countdownSeconds : null,
          currentQuestionIndex,
          totalQuestions: questions.length,
          currentQuestion: currentQ ? {
            ...currentQ,
            choices: isOffTheDome ? null : (currentQ.choices || null)
          } : null,
          timerRemaining,
          timerDuration: activeTimerDuration,
          isOffTheDome,
          isFirstOffTheDome,
          answeredCount: Array.from(playerAnswers.values()).filter(a => a.answer !== undefined).length,
          totalPlayers: participatingPlayers.length,
          playerBuzzStatus,
          scores: Array.from(scores.entries()).map(([id, score]) => {
            const roomPlayer = roomPlayers.find(p => p.socketId === id);
            const name = roomPlayer?.name || roomManager.getPlayerName(id) || `Player-${id.slice(0, 4)}`;
            return { socketId: id, name, score };
          }),
          disconnectedPlayers: Array.from(disconnectedTracker.values())
        };
      },

      teardown() {
        // Cleanup timers
        stopQuestionTimer();
        if (countdownInterval) {
          clearInterval(countdownInterval);
          countdownInterval = null;
        }
        questions = [];
        scores.clear();
        playerAnswers.clear();
        disconnectedTracker.clear();
        gameSettings = null;
        activeTimerDuration = 30;
        timerRemainingAtPause = 0;
      }
    };
  }
};

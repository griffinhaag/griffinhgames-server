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

function fuzzyMatch(userAnswer, correctAnswer) {
  if (!userAnswer || !correctAnswer) return false;
  const norm = (s) => s.toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
  const a = norm(userAnswer);
  const b = norm(correctAnswer);
  if (a === b) return true;
  // Word-order independent
  const sortW = (s) => s.split(" ").filter(w => w).sort().join(" ");
  if (sortW(a) === sortW(b)) return true;
  // Remove filler words
  const noFill = (s) => s.split(" ")
    .filter(w => !["the", "a", "an", "of", "in", "at", "to", "and"].includes(w))
    .join(" ");
  const ac = noFill(a), bc = noFill(b);
  if (ac === bc || sortW(ac) === sortW(bc)) return true;
  // Simple stemming: remove trailing s/es
  const stem = (s) => s.replace(/ies\b/g, "y").replace(/es\b/g, "").replace(/s\b/g, "");
  if (stem(ac) === stem(bc) || sortW(stem(ac)) === sortW(stem(bc))) return true;
  // Levenshtein for short strings
  const maxLen = Math.max(a.length, b.length);
  if (maxLen > 0 && maxLen <= 8) return levenshtein(a, b) <= 1;
  if (maxLen > 8 && maxLen <= 16) return levenshtein(a, b) <= 2;
  return false;
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
    let timerDuration = 30; // 5-120 seconds, host configurable
    let questionTimer = null;
    let questionStartTime = null;
    let timerRemaining = 0
    let activeTimerDuration = 30; // Timer duration for the current question (may differ for OFF THE DOME)
    let timerRemainingAtPause = 0; // Timer remaining when game was paused
    let firstBonusEnabled = true; // Whether first correct answer gets +50 bonus
    let hostAsPlayer = true; // Whether the host participates as a player (false = spectate/admin only)

    // Initialize scores for existing players
    room.players.forEach((p) => {
      if (p.socketId && p.name) {
        scores.set(p.socketId, 0);
        scoresByName.set(p.name.toLowerCase(), 0);
      }
    });

    // Listen for new players joining and initialize/restore their scores
    const checkAndAddPlayer = (socketId, isReconnecting = false) => {
      const player = room.players.get(socketId);
      if (!player) return;

      // Don't track scores for spectating host
      if (!hostAsPlayer && player.isHost) return;

      const playerName = player.name;
      const nameLower = playerName?.toLowerCase();

      if (isReconnecting && nameLower && scoresByName.has(nameLower)) {
        // Restore score for reconnecting player
        const savedScore = scoresByName.get(nameLower);
        scores.set(socketId, savedScore);
        logInfo(`Restored score ${savedScore} for reconnecting player ${playerName}`);
      } else if (!scores.has(socketId)) {
        // New player, initialize score
        scores.set(socketId, 0);
        if (nameLower) {
          scoresByName.set(nameLower, 0);
        }
      }
    };

    // Helper to update scoresByName when scores change
    const updateScoreByName = (socketId, score) => {
      scores.set(socketId, score);
      const player = room.players.get(socketId);
      if (player?.name) {
        scoresByName.set(player.name.toLowerCase(), score);
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
        (questions.length - currentQuestionIndex) <= 3;

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
        currentQuestionIndex === questions.length - 3;

      const state = {
        phase,
        hostAsPlayer,
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
        })
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

      // Initialize scores for any new players (skip spectating host)
      room.players.forEach((p) => {
        if (p.socketId && !scores.has(p.socketId) && (hostAsPlayer || !p.isHost)) {
          scores.set(p.socketId, 0);
        }
      });

      broadcastState();
    }

    function showQuestion() {
      if (phase !== "waiting") return;

      phase = "question";
      playerAnswers.clear(); // Reset answers for new question

      // OFF THE DOME questions get at least 60 seconds regardless of slider
      const isOTD = currentQuestionIndex >= 0 &&
        (questions.length - currentQuestionIndex) <= 3;
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
      phase = "result";

      // Calculate scores based on answers
      const currentQ = questions[currentQuestionIndex];
      const correctAnswer = currentQ?.answer?.toLowerCase().trim();

      // Only use fuzzy matching for OFF THE DOME (free-text) questions;
      // multiple choice answers must match exactly since options are concrete.
      const isOTD = currentQuestionIndex >= 0 &&
        (questions.length - currentQuestionIndex) <= 3;

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
        const playerName = roomPlayer?.name || roomManager.getPlayerName(socketId) || `Player-${socketId.slice(0, 4)}`;

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
          const oldScore = scores.get(socketId) || 0;
          updateScoreByName(socketId, oldScore + points);
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
            gameSettings = {
              categories: selectedCategories,
              questionCount: payload?.questionCount || 10,
              timerDuration: timerDuration,
              bonusFirstCorrect: firstBonusEnabled
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

            if (questions.length === 0) {
              // Fallback to all questions if filtered result is empty
              questions = shuffle(allQuestions).slice(0, Math.min(10, allQuestions.length));
            }
            
            // Initialize scores — skip host if spectating
            scores.clear();
            scoresByName.clear();
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
            activeTimerDuration = timerDuration;

            // Reset all scores — skip host if spectating
            scores.clear();
            scoresByName.clear();
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
            if (phase !== "question" && phase !== "result") return;

            stopQuestionTimer();

            if (phase === "question") {
              // Skip without awarding points
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

            // Shuffle current question + all remaining into a new order
            if (currentQuestionIndex < questions.length - 1) {
              // Include current question in the pool so it may change
              const shufflePool = shuffle(questions.slice(currentQuestionIndex));

              questions = [
                ...questions.slice(0, currentQuestionIndex),
                ...shufflePool
              ];

              // Stop the timer and reset to "waiting" so the host clicks Show Question fresh
              stopQuestionTimer();
              playerAnswers.clear();
              currentQuestionIndex--; // nextQuestion() will increment back
              nextQuestion();         // phase = "waiting", timer reset on Show Question

              io.to(room.code).emit("game:event", {
                type: "questions_shuffled",
                message: "Questions reshuffled!"
              });
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

            // Record buzz timestamp (answer will come later)
            playerAnswers.set(socketId, {
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
              // Player hasn't buzzed yet - auto-buzz and submit in one action
              playerAnswers.set(socketId, {
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
                 const current = scores.get(payload.playerId) || 0;
                 scores.set(payload.playerId, current + payload.delta);
                 broadcastState();
             }
             break;
             
          case "player:joined":
            // When a player joins an in-progress game, initialize or restore their score
            const isReconnecting = payload?.isReconnecting || false;
            checkAndAddPlayer(socketId, isReconnecting);
            // Broadcast state so the new player gets it
            broadcastState();

            if (isReconnecting) {
              const player = room.players.get(socketId);
              io.to(room.code).emit("game:event", {
                type: "player_reconnected",
                playerName: player?.name || "Player",
                playerId: socketId
              });
            }
            break;

          case "player:disconnected":
            // Handle player disconnection mid-game
            // Note: Score is preserved in scoresByName for reconnection
            // The score by socketId is removed, but scoresByName keeps it
            const disconnectedPlayer = room.players.get(socketId);
            if (disconnectedPlayer?.name) {
              const currentScore = scores.get(socketId) || 0;
              scoresByName.set(disconnectedPlayer.name.toLowerCase(), currentScore);
              logInfo(`Saved score ${currentScore} for disconnected player ${disconnectedPlayer.name}`);
            }

            playerAnswers.delete(socketId);
            scores.delete(socketId);

            // Notify others of disconnection
            io.to(room.code).emit("game:event", {
              type: "player_disconnected",
              playerName: disconnectedPlayer?.name || "Player"
            });

            // Check if all remaining players have answered
            if (phase === "question") {
              checkAllAnswered();
            }
            broadcastState();
            break;
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
          (questions.length - currentQuestionIndex) <= 3;
        const isFirstOffTheDome = isOffTheDome &&
          currentQuestionIndex === questions.length - 3;

        const currentQ = currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
          ? questions[currentQuestionIndex]
          : null;

        return {
          phase,
          hostAsPlayer,
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
          })
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
        gameSettings = null;
        activeTimerDuration = 30;
        timerRemainingAtPause = 0;
      }
    };
  }
};

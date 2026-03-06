import { createRequire } from "module";
const require = createRequire(import.meta.url);
const allQuestions = require("./questions.json");

export default {
  id: "buzzin",
  name: "BuzzIn! Game Show",
  description: "The ultimate multiplayer trivia face-off! Race to buzz in, answer correctly, and sabotage your friends.",
  minPlayers: 2,
  maxPlayers: 16,
  icon: "🚨",

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

    // --- Helper Functions ---

    function broadcastState() {
      const currentQ =
        currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
          ? questions[currentQuestionIndex]
          : null;

      // Get all players from room to ensure we have valid names
      const roomPlayers = Array.from(room.players.values());

      // Build player buzz/answer status (show who buzzed, but hide answers)
      const playerBuzzStatus = roomPlayers
        .filter(p => p.socketId)
        .map(p => {
          const answerData = playerAnswers.get(p.socketId);
          return {
            socketId: p.socketId,
            name: p.name || roomManager.getPlayerName(p.socketId) || `Player-${p.socketId.slice(0, 4)}`,
            hasBuzzed: !!answerData,
            hasAnswered: !!(answerData?.answer !== undefined)
          };
        });

      const state = {
        phase,
        currentQuestion: currentQ,
        currentQuestionIndex,
        totalQuestions: questions.length,
        countdownSeconds: phase === "countdown" ? countdownSeconds : null,
        // Timer state
        timerRemaining,
        timerDuration,
        // Answer tracking
        answeredCount: Array.from(playerAnswers.values()).filter(a => a.answer !== undefined).length,
        totalPlayers: roomPlayers.filter(p => p.socketId).length,
        playerBuzzStatus,
        // Scores
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

      // Initialize scores for any new players
      room.players.forEach((p) => {
        if (p.socketId && !scores.has(p.socketId)) {
          scores.set(p.socketId, 0);
        }
      });

      broadcastState();
    }

    function showQuestion() {
      if (phase !== "waiting") return;

      phase = "question";
      playerAnswers.clear(); // Reset answers for new question

      // Start the question timer
      startQuestionTimer();

      io.to(room.code).emit("game:event", { type: "question_shown" });
      broadcastState();
    }

    // --- Timer Functions ---

    function startQuestionTimer() {
      questionStartTime = Date.now();
      timerRemaining = timerDuration;

      questionTimer = setInterval(() => {
        timerRemaining = Math.max(0, timerDuration - Math.floor((Date.now() - questionStartTime) / 1000));
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
      // Check if all active players have submitted answers
      const activePlayers = Array.from(room.players.values()).filter(p => p.socketId);
      const answeredPlayers = Array.from(playerAnswers.values()).filter(a => a.answer !== undefined);

      if (answeredPlayers.length >= activePlayers.length && activePlayers.length > 0) {
        stopQuestionTimer();
        endAnsweringPhase();
      }
    }

    function endAnsweringPhase() {
      phase = "result";

      // Calculate scores based on answers
      const currentQ = questions[currentQuestionIndex];
      const correctAnswer = currentQ?.answer?.toLowerCase().trim();

      // Find first correct answer by timestamp
      let firstCorrectId = null;
      let firstCorrectTime = Infinity;
      let firstBuzzTime = Infinity;

      // First pass: determine correctness and find first correct
      playerAnswers.forEach((data, socketId) => {
        const playerAnswer = data.answer?.toLowerCase().trim();
        const isCorrect = playerAnswer === correctAnswer;
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

        if (data.isCorrect) {
          if (socketId === firstCorrectId) {
            points = 150; // First correct bonus
            eventType = "first_correct";
          } else {
            points = 100; // Standard correct
            eventType = "correct";
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
            if (room.hostSocketId !== socketId) return;
            if (phase !== "lobby") return; // Can only start from lobby
            
            // Validate minimum players (host counts as a player)
            if (room.players.size < 2) {
              io.to(socketId).emit("game:event", {
                type: "error",
                message: "Need at least 2 players to start"
              });
              return;
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
            gameSettings = {
              categories: selectedCategories,
              questionCount: payload?.questionCount || 10,
              timerDuration: timerDuration
            };
            
            let filteredQuestions = allQuestions.filter(q => 
              selectedCategories.includes(q.category)
            );
            
            // Get question count (5-50, default 10)
            const requestedCount = Math.min(
              Math.max(5, gameSettings.questionCount),
              50
            );
            
            // Validate we have enough questions
            if (filteredQuestions.length < requestedCount) {
              io.to(socketId).emit("game:event", {
                type: "error",
                message: `Only ${filteredQuestions.length} questions available for selected categories. Please select more categories or reduce question count.`
              });
              return;
            }
            
            // Shuffle and select questions
            questions = filteredQuestions
              .sort(() => 0.5 - Math.random())
              .slice(0, requestedCount);
            
            if (questions.length === 0) {
              // Fallback to all questions if filtered result is empty
              questions = allQuestions
                .sort(() => 0.5 - Math.random())
                .slice(0, Math.min(10, allQuestions.length));
            }
            
            // Initialize all player scores (including host)
            room.players.forEach((p) => {
              if (p.socketId) {
                scores.set(p.socketId, 0);
              }
            });
            
            // Start countdown
            startCountdown();
            break;
            
          case "host:restartGame":
            if (room.hostSocketId !== socketId) return;
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

            // Restore timer duration from settings
            timerDuration = gameSettings.timerDuration || 30;
            
            // Reset all scores
            room.players.forEach((p) => {
              if (p.socketId) {
                scores.set(p.socketId, 0);
              }
            });
            
            // Re-randomize questions with same settings
            let filteredQuestionsRestart = allQuestions.filter(q => 
              gameSettings.categories.includes(q.category)
            );
            
            questions = filteredQuestionsRestart
              .sort(() => 0.5 - Math.random())
              .slice(0, Math.min(gameSettings.questionCount, filteredQuestionsRestart.length));
            
            // Start countdown again
            startCountdown();
            break;
            
          case "host:endGame":
            if (room.hostSocketId !== socketId) return;
            endGame("ended_by_host");
            break;

          case "host:showQuestion":
            if (room.hostSocketId !== socketId) return;
            if (phase === "waiting") {
              showQuestion();
            }
            break;

          case "host:nextQuestion":
            if (room.hostSocketId !== socketId) return;
            if (phase === "result") {
              nextQuestion();
            }
            break;

          case "host:skipRound":
            if (room.hostSocketId !== socketId) return;
            if (phase !== "question" && phase !== "result") return;

            stopQuestionTimer();

            if (phase === "question") {
              // Force end the answering phase with current answers
              endAnsweringPhase();
            }

            // Emit skip event
            io.to(room.code).emit("game:event", {
              type: "round_skipped"
            });
            break;

          case "host:shuffleQuestions":
            if (room.hostSocketId !== socketId) return;
            if (phase === "lobby" || phase === "countdown") return;

            // Shuffle remaining questions (keep current question, shuffle the rest)
            if (currentQuestionIndex < questions.length - 1) {
              const currentQ = questions[currentQuestionIndex];
              const remainingQuestions = questions.slice(currentQuestionIndex + 1);

              // Fisher-Yates shuffle for remaining questions
              for (let i = remainingQuestions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [remainingQuestions[i], remainingQuestions[j]] = [remainingQuestions[j], remainingQuestions[i]];
              }

              // Reconstruct questions array
              questions = [
                ...questions.slice(0, currentQuestionIndex + 1),
                ...remainingQuestions
              ];

              io.to(room.code).emit("game:event", {
                type: "questions_shuffled",
                message: "Remaining questions have been shuffled!"
              });
            }
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
             if (room.hostSocketId !== socketId) return;
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

        // Build player buzz/answer status
        const playerBuzzStatus = roomPlayers
          .filter(p => p.socketId)
          .map(p => {
            const answerData = playerAnswers.get(p.socketId);
            return {
              socketId: p.socketId,
              name: p.name || roomManager.getPlayerName(p.socketId) || `Player-${p.socketId.slice(0, 4)}`,
              hasBuzzed: !!answerData,
              hasAnswered: !!(answerData?.answer !== undefined)
            };
          });

        return {
          phase,
          countdownSeconds: phase === "countdown" ? countdownSeconds : null,
          currentQuestionIndex,
          totalQuestions: questions.length,
          currentQuestion: currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
            ? questions[currentQuestionIndex]
            : null,
          timerRemaining,
          timerDuration,
          answeredCount: Array.from(playerAnswers.values()).filter(a => a.answer !== undefined).length,
          totalPlayers: roomPlayers.filter(p => p.socketId).length,
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
      }
    };
  }
};

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
    let phase = "lobby"; // lobby, waiting, question, buzzed, answering, result, end
    let questions = [];
    let currentQuestionIndex = -1;
    let scores = new Map(); // socketId -> number
    let buzzState = {
      locked: false,
      buzzedPlayerId: null,
      timestamp: null
    };
    let answerTimeout = null; // Timer for answer submission

    // Initialize scores for existing players
    room.players.forEach((p) => {
      if (p.socketId && p.name) {
        scores.set(p.socketId, 0);
      }
    });
    
    // Listen for new players joining and initialize their scores
    const checkAndAddPlayer = (socketId) => {
      if (!scores.has(socketId)) {
        const player = room.players.get(socketId);
        if (player) {
          scores.set(socketId, 0);
        }
      }
    };

    // --- Helper Functions ---

    function broadcastState() {
      const currentQ =
        currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
          ? questions[currentQuestionIndex]
          : null;

      // Get all players from room to ensure we have valid names
      const roomPlayers = Array.from(room.players.values());
      
      const state = {
        phase,
        currentQuestion: currentQ,
        currentQuestionIndex,
        totalQuestions: questions.length,
        scores: Array.from(scores.entries()).map(([id, score]) => {
          // Get name from room player or roomManager, with fallback
          const roomPlayer = roomPlayers.find(p => p.socketId === id);
          const name = roomPlayer?.name || roomManager.getPlayerName(id) || `Player-${id.slice(0, 4)}`;
          return {
            socketId: id,
            name: name,
            score: score
          };
        }),
        buzzState: {
          locked: buzzState.locked,
          buzzedPlayerId: buzzState.buzzedPlayerId,
          buzzedPlayerName: buzzState.buzzedPlayerId
            ? (roomPlayers.find(p => p.socketId === buzzState.buzzedPlayerId)?.name || 
               roomManager.getPlayerName(buzzState.buzzedPlayerId) || 
               `Player-${buzzState.buzzedPlayerId.slice(0, 4)}`)
            : null
        }
      };

      io.to(room.code).emit("game:state", state);
    }

    function nextQuestion() {
      // Clear any existing answer timeout
      if (answerTimeout) {
        clearTimeout(answerTimeout);
        answerTimeout = null;
      }
      
      currentQuestionIndex++;
      
      if (currentQuestionIndex >= questions.length) {
        endGame();
        return;
      }

      // First show "waiting" phase - host must click "Show Question"
      phase = "waiting";
      buzzState = { locked: true, buzzedPlayerId: null, timestamp: null };
      
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
      buzzState = { locked: false, buzzedPlayerId: null, timestamp: null };
      
      io.to(room.code).emit("game:event", { type: "question_shown" });
      broadcastState();
    }

    function endGame() {
      phase = "end";
      broadcastState();
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
            
            // Validate minimum players
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
            
            let filteredQuestions = allQuestions.filter(q => 
              selectedCategories.includes(q.category)
            );
            
            // Get question count (5-50, default 10)
            const questionCount = Math.min(
              Math.max(5, payload?.questionCount || 10),
              50
            );
            
            // Shuffle and select questions
            questions = filteredQuestions
              .sort(() => 0.5 - Math.random())
              .slice(0, Math.min(questionCount, filteredQuestions.length));
            
            if (questions.length === 0) {
              // Fallback to all questions if filtered result is empty
              questions = allQuestions
                .sort(() => 0.5 - Math.random())
                .slice(0, 10);
            }
            
            // Initialize all player scores
            room.players.forEach((p) => {
              if (p.socketId) {
                scores.set(p.socketId, 0);
              }
            });
            
            currentQuestionIndex = -1;
            nextQuestion(); // This sets phase to "waiting"
            break;

          case "host:showQuestion":
            if (room.hostSocketId !== socketId) return;
            if (phase === "waiting") {
              showQuestion();
            }
            break;

          case "host:nextQuestion":
            if (room.hostSocketId !== socketId) return;
            if (phase === "result" || phase === "buzzed") {
              nextQuestion();
            }
            break;

          case "player:buzz":
            // Validate: can only buzz if phase is 'question' and not locked
            if (phase !== "question") {
              return; // Silently ignore if not in question phase
            }
            
            if (buzzState.locked) {
              return; // Already locked, ignore duplicate buzz
            }
            
            // Check if player exists in room
            if (!room.players.has(socketId)) {
              return; // Player not in room
            }

            // Lock the buzzer atomically
            buzzState.locked = true;
            buzzState.buzzedPlayerId = socketId;
            buzzState.timestamp = Date.now();
            phase = "buzzed";

            // Broadcast immediately
            broadcastState();
            io.to(room.code).emit("game:event", { 
              type: "buzz", 
              playerId: socketId 
            });
            
            // Start answer timeout (30 seconds)
            answerTimeout = setTimeout(() => {
              if (phase === "buzzed" && buzzState.buzzedPlayerId === socketId) {
                // Timeout - deduct points
                const oldScore = scores.get(socketId) || 0;
                scores.set(socketId, oldScore - 25);
                
                io.to(room.code).emit("game:event", {
                  type: "timeout",
                  playerId: socketId,
                  points: -25
                });
                
                phase = "result";
                broadcastState();
              }
            }, 30000);
            break;
            
          case "player:submitAnswer":
            // Player submits their answer
            if (phase !== "buzzed" || buzzState.buzzedPlayerId !== socketId) {
              return; // Not the buzzer or wrong phase
            }
            
            // Clear timeout since answer was submitted
            if (answerTimeout) {
              clearTimeout(answerTimeout);
              answerTimeout = null;
            }
            
            // Move to answering phase (host will judge)
            phase = "answering";
            broadcastState();
            break;

          case "host:judgeAnswer":
            if (room.hostSocketId !== socketId) return;
            if (phase !== "buzzed" && phase !== "answering") return;
            
            // payload: { correct: true/false }
            const buzzerId = buzzState.buzzedPlayerId;
            if (!buzzerId) return;
            
            // Clear timeout if still active
            if (answerTimeout) {
              clearTimeout(answerTimeout);
              answerTimeout = null;
            }

            if (payload.correct === true) {
              // Correct! +100 points
              const oldScore = scores.get(buzzerId) || 0;
              scores.set(buzzerId, oldScore + 100);
              
              io.to(room.code).emit("game:event", { 
                type: "correct", 
                playerId: buzzerId,
                points: 100
              });
              
              phase = "result";
              
            } else if (payload.correct === false) {
              // Wrong! -50 points
              const oldScore = scores.get(buzzerId) || 0;
              scores.set(buzzerId, oldScore - 50);
              
              io.to(room.code).emit("game:event", { 
                type: "wrong", 
                playerId: buzzerId,
                points: -50
              });

              phase = "result";
            }

            broadcastState();
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
             // When a player joins an in-progress game, initialize their score
             checkAndAddPlayer(socketId);
             // Broadcast state so the new player gets it
             broadcastState();
             break;
        }
      },

      getState() {
        const roomPlayers = Array.from(room.players.values());
        return {
            phase,
            currentQuestionIndex,
            totalQuestions: questions.length,
            currentQuestion: currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
              ? questions[currentQuestionIndex]
              : null,
            scores: Array.from(scores.entries()).map(([id, score]) => {
              const roomPlayer = roomPlayers.find(p => p.socketId === id);
              const name = roomPlayer?.name || roomManager.getPlayerName(id) || `Player-${id.slice(0, 4)}`;
              return { socketId: id, name, score };
            }),
            buzzState: {
              locked: buzzState.locked,
              buzzedPlayerId: buzzState.buzzedPlayerId,
              buzzedPlayerName: buzzState.buzzedPlayerId
                ? (roomPlayers.find(p => p.socketId === buzzState.buzzedPlayerId)?.name || 
                   roomManager.getPlayerName(buzzState.buzzedPlayerId) || 
                   `Player-${buzzState.buzzedPlayerId.slice(0, 4)}`)
                : null
            }
        };
      },

      teardown() {
        // Cleanup if needed
        if (answerTimeout) {
          clearTimeout(answerTimeout);
          answerTimeout = null;
        }
        questions = [];
        scores.clear();
      }
    };
  }
};

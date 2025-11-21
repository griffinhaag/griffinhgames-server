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
    let phase = "lobby"; // lobby, question, buzzed, result, end
    let questions = [];
    let currentQuestionIndex = -1;
    let scores = new Map(); // socketId -> number
    let buzzState = {
      locked: false,
      buzzedPlayerId: null,
      timestamp: null
    };

    // Initialize scores for existing players
    room.players.forEach((p) => scores.set(p.socketId, 0));

    // --- Helper Functions ---

    function broadcastState() {
      const currentQ =
        currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
          ? questions[currentQuestionIndex]
          : null;

      const state = {
        phase,
        currentQuestion: currentQ,
        currentQuestionIndex,
        totalQuestions: questions.length,
        scores: Array.from(scores.entries()).map(([id, score]) => ({
          socketId: id,
          name: roomManager.getPlayerName(id),
          score
        })),
        buzzState: {
          locked: buzzState.locked,
          buzzedPlayerId: buzzState.buzzedPlayerId,
          buzzedPlayerName: buzzState.buzzedPlayerId
            ? roomManager.getPlayerName(buzzState.buzzedPlayerId)
            : null
        }
      };

      io.to(room.code).emit("game:state", state);
    }

    function nextQuestion() {
      currentQuestionIndex++;
      
      if (currentQuestionIndex >= questions.length) {
        endGame();
        return;
      }

      phase = "question";
      buzzState = { locked: false, buzzedPlayerId: null, timestamp: null };
      
      // Play sound or visual cue for new question
      io.to(room.code).emit("game:event", { type: "new_question" });
      broadcastState();
    }

    function endGame() {
      phase = "end";
      broadcastState();
    }

    return {
      // --- Socket Event Handler ---
      handleEvent({ eventName, payload, socketId }) {
        // Ensure player has a score entry if they joined late (optional)
        if (!scores.has(socketId)) scores.set(socketId, 0);

        switch (eventName) {
          case "host:startGame":
            if (room.hostSocketId !== socketId) return;
            
            // Filter questions by selected categories
            const selectedCategories = payload?.categories || [];
            let filteredQuestions = allQuestions;
            
            if (selectedCategories.length > 0) {
              filteredQuestions = allQuestions.filter(q => 
                selectedCategories.includes(q.category)
              );
            }
            
            // Default to 10 questions if none specified, or use all available
            const questionCount = payload?.questionCount || Math.min(10, filteredQuestions.length);
            
            // Shuffle and select questions
            questions = filteredQuestions
              .sort(() => 0.5 - Math.random())
              .slice(0, questionCount);
            
            if (questions.length === 0) {
              // Fallback to all questions if filtered result is empty
              questions = allQuestions
                .sort(() => 0.5 - Math.random())
                .slice(0, 10);
            }
            
            currentQuestionIndex = -1;
            nextQuestion();
            break;

          case "host:nextQuestion":
            if (room.hostSocketId !== socketId) return;
            nextQuestion();
            break;

          case "player:buzz":
            // Can only buzz if phase is 'question' and not locked
            if (phase !== "question" || buzzState.locked) return;

            // Lock the buzzer
            phase = "buzzed";
            buzzState.locked = true;
            buzzState.buzzedPlayerId = socketId;
            buzzState.timestamp = Date.now();

            // Broadcast immediately
            broadcastState();
            io.to(room.code).emit("game:event", { 
              type: "buzz", 
              playerId: socketId 
            });
            break;

          case "host:judgeAnswer":
            if (room.hostSocketId !== socketId) return;
            // payload: { correct: true/false }
            
            const buzzerId = buzzState.buzzedPlayerId;
            if (!buzzerId) return;

            if (payload.correct) {
              // Correct! +100 points
              const oldScore = scores.get(buzzerId) || 0;
              scores.set(buzzerId, oldScore + 100);
              
              io.to(room.code).emit("game:event", { 
                type: "correct", 
                playerId: buzzerId,
                points: 100
              });
              
              // Move to result phase momentarily, then next question or allow host to click next
              // For flow, let's stay on "result" phase until host clicks next
              phase = "result";
              
            } else {
              // Wrong! -50 points
              const oldScore = scores.get(buzzerId) || 0;
              scores.set(buzzerId, oldScore - 50);
              
              io.to(room.code).emit("game:event", { 
                type: "wrong", 
                playerId: buzzerId,
                points: -50
              });

              // Unlock buzzer so others can try? 
              // Or lock out this question? 
              // Rule: "First buzz locks everyone else out." -> so we move to result/next
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
        }
      },

      getState() {
        return {
            phase,
            currentQuestionIndex,
            totalQuestions: questions.length,
            scores: Array.from(scores.entries()).map(([id, score]) => ({
              socketId: id,
              name: roomManager.getPlayerName(id),
              score
            })),
            buzzState
        };
      },

      teardown() {
        // Cleanup if needed
        questions = [];
        scores.clear();
      }
    };
  }
};

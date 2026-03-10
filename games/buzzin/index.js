import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Groq from "groq-sdk";

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

  // Deduplicate by question text — prevents repeats if a question appears in multiple category files
  const deduped = [];
  const seenTexts = new Set();
  for (const q of questions) {
    if (!seenTexts.has(q.question)) {
      seenTexts.add(q.question);
      deduped.push(q);
    }
  }
  return deduped;
}

const allQuestions = loadAllQuestions();
console.log(`[BuzzIn] Loaded ${allQuestions.length} questions from ${new Set(allQuestions.map(q => q.category)).size} categories`);

// Pre-compute per-category counts from the deduplicated allQuestions array.
// This is what the /buzzin/category-counts endpoint should expose so the
// client slider always reflects the real available pool (post-dedup).
const categoryCounts = {};
for (const q of allQuestions) {
  categoryCounts[q.category] = (categoryCounts[q.category] || 0) + 1;
}

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

// Common abbreviation/acronym expansions for trivia answer matching.
// Only applied when the ENTIRE normalized answer equals a key — no partial-word expansion
// to avoid false positives (e.g., "aids" inside "hearing aids" must not expand mid-phrase).
const ABBREVIATIONS = {
  "usa": "united states america",
  "uk": "united kingdom",
  "wwi": "world war 1",
  "wwii": "world war 2",
  "jfk": "john kennedy",
  "nyc": "new york city",
  "ussr": "soviet union",
  "dna": "deoxyribonucleic acid",
  "nasa": "national aeronautics space administration",
  "ufo": "unidentified flying object",
  "nba": "national basketball association",
  "nfl": "national football league",
  "mlb": "major league baseball",
  "nhl": "national hockey league",
  "eu": "european union",
  "fifa": "federation internationale football association",
  "cia": "central intelligence agency",
  "fbi": "federal bureau investigation",
  "nsa": "national security agency",
  "gps": "global positioning system",
  "aids": "acquired immune deficiency syndrome",
  "hiv": "human immunodeficiency virus",
};

function expandAbbreviations(s) {
  return ABBREVIATIONS[s] || s;
}

// Currency and symbol aliases for fuzzy matching
const SYMBOL_ALIASES = {
  "£": "pound sterling",
  "$": "dollar",
  "€": "euro",
  "¥": "yen",
  "₹": "rupee",
  "%": "percent",
  "&": "and",
};

function normalizeSymbols(s) {
  let result = s;
  for (const [sym, word] of Object.entries(SYMBOL_ALIASES)) {
    result = result.split(sym).join(` ${word} `);
  }
  return result.trim().replace(/\s+/g, " ");
}

function normalizeNumbers(s) {
  let result = s;
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, "g"), digit);
  }
  // Combine compound numbers: e.g. "20 6" → "26", "30 5" → "35"
  // Covers cases where number words are used for compound values ("twenty six" → "20 6" → "26")
  result = result.replace(/\b([2-9]0) ([1-9])\b/g, (_, tens, ones) => String(+tens + +ones));
  // Hundreds: "100 20 6" → "126", "100 20" → "120", "100 6" → "106"
  result = result.replace(/\b(1[0-9]{2}) ([2-9]0) ([1-9])\b/g, (_, h, t, o) => String(+h + +t + +o));
  result = result.replace(/\b(1[0-9]{2}) ([2-9]0)\b/g, (_, h, t) => String(+h + +t));
  result = result.replace(/\b(1[0-9]{2}) ([1-9])\b/g, (_, h, o) => String(+h + +o));
  return result;
}

// Returns true if the string (after spaces removed) is purely numeric
const isPureNumber = (s) => /^\d+$/.test(s.replace(/\s+/g, ""));

// Groq AI client for intelligent OTD answer grading
const groqClient = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;
if (groqClient) {
  console.log("[BuzzIn] Groq client initialized (llama-3.1-8b-instant)");
} else {
  console.warn("[BuzzIn] GROQ_API_KEY not set — AI grading disabled");
}

async function gradeAnswerWithGroq(userAnswer, correctAnswer) {
  if (!groqClient || !userAnswer || !correctAnswer) return false;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 6000)
    );
    const gradePromise = groqClient.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{
        role: "user",
        content:
          `Trivia answer grading. Correct answer: "${correctAnswer}". Player answered: "${userAnswer}". ` +
          `Accept if: exact or near-exact match, common abbreviation (e.g. DNA for deoxyribonucleic acid), ` +
          `last name only for a full name answer, 1-2 character typo, alternate spelling, partial answer that ` +
          `unambiguously identifies the correct answer (e.g. "Pacific" for "Pacific Ocean"), ` +
          `or the answer contains the correct answer as part of a larger valid response (e.g. "November 9, 1989" for "1989"). ` +
          `Reject if: referring to a clearly different thing, too vague, or only loosely related. ` +
          `Reply with only "yes" or "no".`
      }],
      max_tokens: 5,
      temperature: 0,
    });
    const result = await Promise.race([gradePromise, timeoutPromise]);
    const text = result.choices[0]?.message?.content?.toLowerCase().trim() ?? "";
    return text.startsWith("yes");
  } catch (e) {
    console.error(`[BuzzIn] Groq grading error: ${e?.message || e}`);
    return false;
  }
}

function fuzzyMatch(userAnswer, correctAnswer) {
  if (!userAnswer || !correctAnswer) return false;

  // Expand currency/special symbols before stripping non-alphanumeric chars
  const norm = (s) => normalizeSymbols(s).toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
  const a = norm(userAnswer);
  const b = norm(correctAnswer);

  if (a === b) return true;

  // Normalize number words to digits for both strings
  const aN = normalizeNumbers(a);
  const bN = normalizeNumbers(b);

  // If either side is a pure number after normalization, require exact digit match.
  // This prevents "five" matching "6" and allows "twenty six" matching "26".
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

  // Abbreviation/acronym expansion: if either whole answer is a known abbreviation, expand and compare.
  const aE = expandAbbreviations(a);
  const bE = expandAbbreviations(b);
  if (aE !== a || bE !== b) {
    const noFillLocal = (s) => s.split(" ")
      .filter(w => !["the", "a", "an", "of", "in", "at", "to", "and"].includes(w))
      .join(" ");
    if (aE === b || a === bE || aE === bE) return true;
    if (noFillLocal(aE) === noFillLocal(b) || noFillLocal(a) === noFillLocal(bE)) return true;
  }

  // Partial answer acceptance: user typed a single significant word that appears in a multi-word
  // correct answer (e.g. "Pacific" for "Pacific Ocean", "Jordan" for "Michael Jordan").
  // Requires ≥5 chars to avoid short generic words matching.
  const aWords = a.split(" ").filter(w => w);
  const bWords = b.split(" ").filter(w => w);
  if (bWords.length >= 2 && aWords.length === 1 && a.length >= 5) {
    for (const bw of bWords) {
      if (bw.length >= 5 && (a === bw || levenshtein(a, bw) <= 1)) return true;
    }
  }

  // Levenshtein with tightened thresholds to prevent false positives (e.g. Acrophobia ≠ Agoraphobia).
  // Very short strings (≤ 4): no fuzzy.
  // 5–6: allow 1 edit.
  // 7–9: allow 2 edits.
  // 10+: allow at most 2 edits (genuine 1-2 character typos only).
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 4) return false;
  if (maxLen <= 6) return levenshtein(a, b) <= 1;
  if (maxLen <= 9) return levenshtein(a, b) <= 2;
  const dist = levenshtein(a, b);
  const maxLenClean = Math.max(ac.length, bc.length);
  // Cap at 2 edits for long strings to avoid matching different-but-similar words
  return dist <= 2 || (maxLenClean > 4 && levenshtein(ac, bc) <= 2);
}

// Hard cap on questions per game — enforced on both server and client.
const MAX_QUESTIONS_PER_GAME = 100;

export default {
  id: "buzzin",
  name: "LOCK IN Trivia",
  description: "Race to buzz in, answer correctly, and sabotage the peeps.",
  minPlayers: 2,
  maxPlayers: 16,
  icon: "💡🦦",
  // Deduplicated per-category counts — used by the /buzzin/category-counts endpoint
  // so the client slider always reflects the true available pool.
  categoryCounts,
  maxQuestionsPerGame: MAX_QUESTIONS_PER_GAME,

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
    let offTheDomeCount = 3; // Number of "OFF THE DOME" free-text questions
    let otdAtEnd = false;   // false = distribute OTD randomly (default), true = place at end
    // Tracks which question texts are "OFF THE DOME" for the current game (by question text).
    // Using a Set keyed by text means it survives reshuffles and question replacements correctly.
    let otdQuestionTexts = new Set();

    // --- Session-level seen question tracking ---
    // Persists across game restarts within the same room so Play Again never repeats questions.
    // Populated in nextQuestion() as each question is presented, and merged with the client's
    // sessionStorage backup at game start/restart (resilience against server restarts).
    let seenQuestionTexts = new Set();
    // Categories currently selected for this game — used to build the replacement pool for shuffles.
    let currentCategories = [];

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

      // Determine if this is an "OFF THE DOME" question (free-text typing)
      const isOffTheDome = currentQ != null && otdQuestionTexts.has(currentQ.question);

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

      // Show OTD announcement:
      // - At end mode: announce once at the transition (first OTD question)
      // - Distributed mode: announce for every OTD question so players aren't caught off guard
      const isFirstOffTheDome = isOffTheDome && (
        otdAtEnd
          ? questions.slice(0, currentQuestionIndex).every(q => !otdQuestionTexts.has(q.question))
          : true
      );

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

      // Mark this question as seen (server-side — survives game restarts within this room session)
      const nextQ = questions[currentQuestionIndex];
      if (nextQ?.question) seenQuestionTexts.add(nextQ.question);

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
      const curQ = questions[currentQuestionIndex];
      const isOTD = curQ != null && otdQuestionTexts.has(curQ.question);
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

      questionTimer = setInterval(async () => {
        timerRemaining = Math.max(0, activeTimerDuration - Math.floor((Date.now() - questionStartTime) / 1000));
        broadcastState();

        if (timerRemaining <= 0) {
          clearInterval(questionTimer);
          questionTimer = null;
          await endAnsweringPhase();
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

    async function endAnsweringPhase(skipPoints = false) {
      // Guard against double-fire from simultaneous timer expiry + checkAllAnswered
      if (phase !== "question" && phase !== "paused") return;
      phase = "result";

      // Calculate scores based on answers
      const currentQ = questions[currentQuestionIndex];
      const correctAnswer = currentQ?.answer?.toLowerCase().trim();

      // Only use fuzzy/AI matching for OFF THE DOME (free-text) questions;
      // multiple choice answers must match exactly since options are concrete.
      const isOTD = currentQ != null && otdQuestionTexts.has(currentQ.question);

      if (isOTD) {
        // OTD grading: fast fuzzy match first, then Gemini AI for anything not caught by fuzzy.
        // Both run before scoring so we can correctly identify the first correct answer.
        const aiTasks = [];
        playerAnswers.forEach((data) => {
          const playerAnswer = data.answer?.toLowerCase().trim() || "";
          if (!playerAnswer) {
            data.isCorrect = false;
          } else if (fuzzyMatch(playerAnswer, correctAnswer || "")) {
            data.isCorrect = true;
          } else {
            // Not caught by fuzzy — ask Gemini
            aiTasks.push(
              gradeAnswerWithGroq(data.answer, currentQ.answer)
                .then(result => { data.isCorrect = result; })
            );
          }
        });
        if (aiTasks.length > 0) await Promise.allSettled(aiTasks);
      } else {
        // Multiple choice: exact string match
        playerAnswers.forEach((data) => {
          const playerAnswer = data.answer?.toLowerCase().trim();
          data.isCorrect = (playerAnswer === correctAnswer);
        });
      }

      // Find first correct answer by timestamp
      let firstCorrectId = null;
      let firstCorrectTime = Infinity;
      let firstBuzzTime = Infinity;

      playerAnswers.forEach((data, socketId) => {
        if (data.isCorrect && data.timestamp) {
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

    // --- Question Pool Builder ---
    // Returns a pool for the given categories, always preferring questions that have never been
    // seen in this room session. If fewer fresh questions exist than `needed`, it supplements
    // with seen questions (shuffled for fairness) so the game can still run rather than crashing.
    function buildQuestionPool(categories, needed) {
      const categoryFiltered = allQuestions.filter(q => categories.includes(q.category));
      const fresh = categoryFiltered.filter(q => !seenQuestionTexts.has(q.question));
      if (fresh.length >= needed) return fresh;
      // Not enough fresh questions — top up with seen ones (least painful repeat possible)
      const seen = shuffle(categoryFiltered.filter(q => seenQuestionTexts.has(q.question)));
      return [...fresh, ...seen.slice(0, needed - fresh.length)];
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
            otdAtEnd = payload?.otdAtEnd === true;
            // offTheDomeCount is clamped after questions are selected (see below)
            gameSettings = {
              categories: selectedCategories,
              questionCount: payload?.questionCount || 10,
              timerDuration: timerDuration,
              bonusFirstCorrect: firstBonusEnabled,
              offTheDomeCount: payload?.offTheDomeCount ?? 3,
              otdAtEnd: otdAtEnd
            };
            
            // Store selected categories so mid-game shuffle can pull from the same pool
            currentCategories = selectedCategories;

            // Merge client's sessionStorage backup into server-side tracker.
            // This handles the edge case where the server restarted and lost its state.
            const seenQs = payload?.seenQuestions || [];
            seenQs.forEach(q => seenQuestionTexts.add(q));

            // Count total available questions for the chosen categories (including already-seen)
            const categoryFiltered = allQuestions.filter(q => selectedCategories.includes(q.category));

            // Ensure at least 5 questions exist across the selected categories
            if (categoryFiltered.length < 5) {
              io.to(socketId).emit("game:event", {
                type: "error",
                message: `Not enough questions in selected categories (found ${categoryFiltered.length}). Please select more categories.`
              });
              return;
            }

            // Cap requested count: minimum 5, maximum MAX_QUESTIONS_PER_GAME, and never
            // more than total questions available in the selected categories.
            const requestedCount = Math.min(
              Math.max(5, gameSettings.questionCount),
              MAX_QUESTIONS_PER_GAME,
              categoryFiltered.length
            );

            // Build pool preferring unseen questions; supplements with seen ones only if the
            // fresh supply is exhausted (so the game always runs, with minimum possible repeats).
            questions = shuffle(buildQuestionPool(selectedCategories, requestedCount)).slice(0, requestedCount);

            // Clamp offTheDomeCount to actual question count
            offTheDomeCount = Math.max(0, Math.min(gameSettings.offTheDomeCount, questions.length));

            // Mark which questions are "OFF THE DOME" (free-text) for this game.
            // otdAtEnd = true → last offTheDomeCount questions; false → randomly distributed.
            otdQuestionTexts.clear();
            if (offTheDomeCount > 0) {
              if (otdAtEnd) {
                questions.slice(questions.length - offTheDomeCount).forEach(q => otdQuestionTexts.add(q.question));
              } else {
                const otdIndices = shuffle([...Array(questions.length).keys()]).slice(0, offTheDomeCount);
                otdIndices.forEach(i => otdQuestionTexts.add(questions[i].question));
              }
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
            if (payload.otdAtEnd !== undefined) {
              otdAtEnd = payload.otdAtEnd === true;
              gameSettings.otdAtEnd = otdAtEnd;
            } else {
              otdAtEnd = gameSettings.otdAtEnd === true;
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
            
            // Update category pool for mid-game shuffle
            currentCategories = gameSettings.categories;

            // Merge client's sessionStorage backup (resilience against server restarts)
            const seenQsRestart = payload?.seenQuestions || [];
            seenQsRestart.forEach(q => seenQuestionTexts.add(q));

            // At this point seenQuestionTexts already contains every question asked in previous
            // games this session (added by nextQuestion()). Build a fresh pool accordingly.
            const restartCategoryFiltered = allQuestions.filter(q => gameSettings.categories.includes(q.category));
            const restartCount = Math.min(
              Math.max(5, gameSettings.questionCount),
              MAX_QUESTIONS_PER_GAME,
              restartCategoryFiltered.length
            );
            questions = shuffle(buildQuestionPool(gameSettings.categories, restartCount)).slice(0, restartCount);

            // Clamp offTheDomeCount to actual question count
            offTheDomeCount = Math.max(0, Math.min(gameSettings.offTheDomeCount ?? 3, questions.length));

            // Mark OTD questions for this game
            otdQuestionTexts.clear();
            if (offTheDomeCount > 0) {
              if (otdAtEnd) {
                questions.slice(questions.length - offTheDomeCount).forEach(q => otdQuestionTexts.add(q.question));
              } else {
                const otdIndices = shuffle([...Array(questions.length).keys()]).slice(0, offTheDomeCount);
                otdIndices.forEach(i => otdQuestionTexts.add(questions[i].question));
              }
            }

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

                // Try to replace the current question with a brand-new one from the full pool.
                // Replacement pool = questions in the selected categories that:
                //   1. Have never been seen in this room session (seenQuestionTexts), AND
                //   2. Are not already queued in the current game (to avoid queue duplicates).
                const gameQSet = new Set(questions.map(q => q.question));
                const replacementPool = allQuestions.filter(q =>
                  currentCategories.includes(q.category) &&
                  !seenQuestionTexts.has(q.question) &&
                  !gameQSet.has(q.question)
                );

                if (replacementPool.length > 0) {
                  // Pick a random fresh replacement.
                  // Remove currentQ from seenQuestionTexts — it was never answered, so it
                  // should stay available for future games (not burned as "used").
                  const replacementQ = replacementPool[Math.floor(Math.random() * replacementPool.length)];
                  seenQuestionTexts.delete(currentQ.question);
                  // Transfer OTD designation: if the skipped question was OTD, the replacement is too.
                  if (otdQuestionTexts.has(currentQ.question)) {
                    otdQuestionTexts.delete(currentQ.question);
                    otdQuestionTexts.add(replacementQ.question);
                  }
                  questions = [...alreadyAsked, replacementQ, ...notYetAsked];
                  currentQuestionIndex--; // nextQuestion() increments back, marks replacementQ seen
                  nextQuestion();
                } else if (notYetAsked.length > 0) {
                  // Fresh pool exhausted — fall back to reshuffling the existing remaining
                  // questions, still guaranteeing a different question comes next.
                  const combinedPool = shuffle([currentQ, ...notYetAsked]);
                  if (combinedPool[0].question === currentQ.question) {
                    const swapIdx = Math.floor(Math.random() * (combinedPool.length - 1)) + 1;
                    [combinedPool[0], combinedPool[swapIdx]] = [combinedPool[swapIdx], combinedPool[0]];
                  }
                  questions = [...alreadyAsked, ...combinedPool];
                  currentQuestionIndex--;
                  nextQuestion();
                } else {
                  // Last question AND no fresh questions available — stay on it.
                  phase = "waiting";
                  broadcastState();
                }

                io.to(room.code).emit("game:event", {
                  type: "questions_shuffled",
                  message: "Questions reshuffled!"
                });
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

        const currentQ = currentQuestionIndex >= 0 && currentQuestionIndex < questions.length
          ? questions[currentQuestionIndex]
          : null;

        // Determine if OFF THE DOME
        const isOffTheDome = currentQ != null && otdQuestionTexts.has(currentQ.question);
        const isFirstOffTheDome = isOffTheDome && (
          otdAtEnd
            ? questions.slice(0, currentQuestionIndex).every(q => !otdQuestionTexts.has(q.question))
            : true
        );

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
        seenQuestionTexts.clear();
        otdQuestionTexts.clear();
        currentCategories = [];
        gameSettings = null;
        activeTimerDuration = 30;
        timerRemainingAtPause = 0;
      }
    };
  }
};

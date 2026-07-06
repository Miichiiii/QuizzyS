const fs = require('fs');
const path = require('path');

const QUESTIONS_FILE = path.join(__dirname, '..', 'questions.json');

function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error("Fehler beim Laden der questions.json:", e);
  }
  return [];
}

function saveQuestions(questions) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8');
  } catch (e) {
    console.error("Fehler beim Speichern der questions.json:", e);
  }
}

function getCategories() {
  const QUESTIONS = loadQuestions();
  return [...new Set(QUESTIONS.map(q => q.category))];
}

function getQuestionsForCategory(category) {
  const QUESTIONS = loadQuestions();
  return QUESTIONS.filter(q => q.category === category);
}

module.exports = { loadQuestions, saveQuestions, getCategories, getQuestionsForCategory };

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function monthText() {
  return todayText().slice(0, 7);
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

module.exports = {
  todayText,
  monthText,
  money
};

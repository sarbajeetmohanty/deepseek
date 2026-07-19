
const fs = require("fs");
const { parseQuestions } = require("./test-parse-req.js");
const raw = fs.readFileSync("test-text.txt", "utf8");
console.log(parseQuestions(raw).length);


const text = `1. What is 2+2?
E. 4
F. 5
Answer: E
Solution:
1. It is 4.
2. Because math.
E. is the letter E.`;

const lines = text.split('\n');

let seenQuestion = false;
let inSolution = false;
let seenAnswer = false;
let seenSolution = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (/^\s*Answer:/i.test(line)) {
    inSolution = false;
    seenAnswer = true;
    console.log("ANSWER:", line);
    continue;
  }
  
  if (/^\s*Solution:/i.test(line)) {
    inSolution = true;
    seenSolution = true;
    console.log("SOLUTION:", line);
    continue;
  }
  
  const optMatch = (!seenAnswer && !seenSolution) ? line.match(/^\s*((?:[A-Ha-h1-8]\.)|(?:\([a-h1-8]\)))(?:\s+(.*))?$/) : null;
  if (optMatch) {
    console.log("OPTION:", optMatch[1], optMatch[2]);
    continue;
  }
  
  const step = inSolution ? line.match(/^\s*(\d{1,2})\.\s+(.*)$/) : null;
  if (step) {
    console.log("STEP:", step[1], step[2]);
    continue;
  }
  
  console.log("TEXT:", line);
}

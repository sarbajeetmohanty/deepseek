const text = `C. 1 और 2 दोनों D. न तो 1 और न ही 2
Solution:
1 मैनोमीटर एक उपकरण है...
2 डेनसिटीमीटर...
3 कथन 1 में मैनोमीटर...
4 कथन`;

let cleanText = text.replace(/(?<!Answer:|Solution:)(?<=\S)[^\S\r\n]+(?=(?:[A-Da-d1-4]\.|\([a-d1-4]\))[^\S\r\n])/g, "\n");
console.log("=== AFTER SPLIT ===");
console.log(cleanText);

const lines = cleanText.split("\n");
const strictOptPattern = /^\s*((?:[A-Da-d1-4]\.)|(?:\([a-d1-4]\)))(?:\s+(.*))?$/;

for (let line of lines) {
  const optMatch = line.match(strictOptPattern);
  if (optMatch) {
    console.log(`OPTION: [${optMatch[1]}] text: ${optMatch[2]}`);
  } else {
    console.log(`TEXT: ${line}`);
  }
}

const regex = /^\s*((?:[A-Ha-h]\.)|(?:\([a-h1-8]\)))(?:\s+(.*))?$/;
console.log("1. एक ड्रैम:", regex.test("1. एक ड्रैम"));
console.log("A. केवल 1 और 2:", regex.test("A. केवल 1 और 2"));
console.log("(a) test:", regex.test("(a) test"));
console.log("(1) test:", regex.test("(1) test"));

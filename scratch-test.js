const text = `47. सूची-I (यांत्रिक/विद्युत उपकरण) और सूची-II (कार्य) का मिलान करें:
  सूची-I
  a. साइक्लोट्रॉन (Cyclotron)
  b. ऑसिलोग्राफ (Oscillograph)
  c. पोटेंशियोमीटर (Potentiometer)
  d. लाइटिंग कण्डक्टर (Lighting conductor) सूची-II 1 विद्युतीय तथा यांत्रिक कम्पनों को ग्राफ़ पर चित्रित करना 2 आवेशित कणों को त्वरित करना 3 बिजली के प्रभाव से इमारतों को सुरक्षित रखना 4 विद्युत्-वाहक बलों की तुलना करना
A. a-2, b-1, c-4, d-3
B. a-1, b-2, c-3, d-4
C. a-2, b-4, c-1, d-3
D. a-4, b-3, c-2, d-1`;

let cleanText = text.replace(/(?<=\S)[^\S\r\n]+((?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)(?:[\s.:\-]+(?=\(?[a-zA-Z1-9]\)?[\s.)])|[\s.:\-]*$))/gim, "\n$1");
cleanText = cleanText.replace(/^([^\S\r\n]*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I{1,3}|1|2)[\s.:\-]*)[^\S\r\n]+(?=\(?[a-zA-Z1-9]\)?[\s.)])/gim, "$1\n");
cleanText = cleanText.replace(/(?<!Answer:)(?<=\S)[^\S\r\n]+(?=(?:\(?[a-dA-D1-4]\)?|[a-dA-D1-4][.)])[^\S\r\n])/g, "\n");

const lines = cleanText.split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim().length > 0);

console.log("=== CHECKING TABLE MATCH ===");
for(const line of lines) {
  if (/^\s*(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|I|1)[:.\-]?/i.test(line)) {
    console.log("MATCHED TABLE START:", line);
  }
}

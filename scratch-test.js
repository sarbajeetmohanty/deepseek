const text = `39. सूची-I का सूची-II से सुमेलित कीजिए:
सूची-I:
a. डायनेमोमीटर (Dynamometer)
b. कैलोरीमीटर (Calorimeter)
c. गैल्वेनोमीटर (Galvanometer)
d. पाइरोमीटर (Pyrometer) सूची-II:
1 ऊष्मा की मात्रा
2 इंजन की शक्ति
3 दूर स्थित वस्तु का ताप
4 विद्युत परिपथ में धारा की दिशा/मात्रा
A. a-2, b-1, c-4, d-3`;

let cleanText = text.replace(/(?<=\S)[ \t]+(?=(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|B|I|II|1|2)[\s.:\-]*)/gi, "\n");
const lines = cleanText.split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim().length > 0);

const colA = [];
const colB = [];

let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:A|I|1)[:.\-]?\s*$/i.test(line)) {
    console.log("MATCHED COLUMN A", line);
    let j = i + 1;
    while (j < lines.length && !/^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)[:.\-]?\s*$/i.test(lines[j])) {
      colA.push(lines[j]);
      j++;
    }
    if (j < lines.length && /^(?:Column|कॉलम|स्तंभ|List|सूची)[\s\-]*(?:B|II|2)[:.\-]?\s*$/i.test(lines[j])) {
      console.log("MATCHED COLUMN B", lines[j]);
      j++; // skip Column B header
      while (j < lines.length && colB.length < colA.length && !/^Answer:/i.test(lines[j]) && !/^Solution:/i.test(lines[j])) {
        colB.push(lines[j]);
        j++;
      }
    }
    console.log("ColA items:", colA);
    console.log("ColB items:", colB);
    i = j - 1;
  }
  i++;
}

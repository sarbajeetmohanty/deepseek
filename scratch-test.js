const text1 = `d. लाइटिंग कण्डक्टर (Lighting conductor) सूची-II 1 विद्युतीय तथा यांत्रिक कम्पनों को ग्राफ़ पर चित्रित करना 2 आवेशित कणों को त्वरित करना 3 बिजली के प्रभाव से इमारतों को सुरक्षित रखना 4 विद्युत्-वाहक बलों की तुलना करना कूट: A. a-2, b-1, c-4, d-3 B. a-1, b-2, c-3, d-4 C. a-2, b-4, c-1, d-3 D. a-4, b-3, c-2, d-1`;

const regex = /(?<!Answer:)(?<=\S)[^\S\r\n]+(?=(?:\(?[a-dA-D1-4]\)?|[a-dA-D1-4][.)])[^\S\r\n])/g;

console.log("Original:", text1);
console.log("Replaced:", text1.replace(regex, "\n"));

const fs = require('fs');
const crypto = require('crypto');

try {
  // .pem dosyasının adını buraya yaz (uzantısıyla beraber)
  const pemPath = './extension.pem'; 
  
  if (!fs.existsSync(pemPath)) {
    console.error("HATA: .pem dosyası bulunamadı! Lütfen adının 'lockeep.pem' olduğundan emin ol.");
    process.exit(1);
  }

  // PEM dosyasını oku
  const pem = fs.readFileSync(pemPath);

  // Açık anahtarı (Public Key) oluştur
  const key = crypto.createPublicKey(pem);

  // Chrome/Brave'in istediği DER formatına çevir
  const der = key.export({ type: 'spki', format: 'der' });

  // Base64 formatına dönüştür
  const base64Key = der.toString('base64');

  console.log("\n=======================================================");
  console.log("İŞTE MANIFEST.JSON İÇİN AÇIK ANAHTARIN:\n");
  console.log(base64Key);
  console.log("=======================================================\n");

} catch (err) {
  console.error("Bir hata oluştu:", err.message);
}
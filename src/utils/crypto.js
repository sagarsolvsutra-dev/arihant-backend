const CryptoJS = require("crypto-js");

const SECRET_KEY = process.env.JWT_SECRET || "arihant-erp-secret-key-2024";

const encryptPassword = (password) => {
  if (!password) return "";
  return CryptoJS.AES.encrypt(password.toString(), SECRET_KEY).toString();
};

const decryptPassword = (encryptedPassword) => {
  if (!encryptedPassword) return "";
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedPassword, SECRET_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    return "";
  }
};

module.exports = {
  encryptPassword,
  decryptPassword,
};

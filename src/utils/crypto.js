const bcrypt = require("bcryptjs");

const SALT_ROUNDS = 10;

const hashPassword = async (password) => {
  return bcrypt.hash(password.toString(), SALT_ROUNDS);
};

const comparePassword = async (password, hash) => {
  if (!password || !hash) return false;
  try {
    return await bcrypt.compare(password.toString(), hash);
  } catch (error) {
    return false;
  }
};

module.exports = {
  hashPassword,
  comparePassword,
};

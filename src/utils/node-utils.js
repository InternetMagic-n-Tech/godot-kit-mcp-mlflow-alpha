
const nodeUtils = {
  homePrefixToEnvHome: (pathStr) => pathStr.replace(/^~\//, `${process.env.HOME}/`)
};
module.exports = nodeUtils;
module.exports.default = nodeUtils;

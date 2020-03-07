const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

module.exports.isSemver = (str) => {
  return semverRe.test(str.replace(/^v/, ""));
};

module.exports.incSemver = (str, level) => {
  if (!module.exports.isSemver(str)) throw new Error(`Invalid semver: ${str}`);
  if (level === "major") return str.replace(/([0-9]+)(\.[0-9]+\.[0-9+])(.*)/, (_, m1, m2, m3) => `${Number(m1) + 1}${m2}${m3}`);
  if (level === "minor") return str.replace(/([0-9]+\.)([0-9]+)(\.[0-9+].*)/, (_, m1, m2, m3) => `${m1}${Number(m2) + 1}${m3}`);
  return str.replace(/([0-9]+\.[0-9]+\.)([0-9+])(.*)/, (_, m1, m2, m3) => `${m1}${Number(m2) + 1}${m3}`);
};

// Minimal build report: print approximate total client-side JS KB
const fs = require('fs')
const path = require('path')

function folderSize(dir, exts = ['.js', '.css']) {
  let total = 0
  if (!fs.existsSync(dir)) return total
  const files = fs.readdirSync(dir)
  for (const f of files) {
    const p = path.join(dir, f)
    const stat = fs.statSync(p)
    if (stat.isDirectory()) total += folderSize(p, exts)
    else if (exts.includes(path.extname(f))) total += stat.size
  }
  return total
}

const nextStatic = path.join(process.cwd(), '.next', 'static', 'chunks')
const size = folderSize(nextStatic)
console.log(`\nBuild report: client static chunks ~ ${(size/1024).toFixed(1)} KB\n`)
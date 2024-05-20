cd .. && npm run build && cd -
lamac example.lama
node ../build/src/main.js example.s --show >  example.orig.dot
node ../build/src/main.js example.s --graph > example.transformed.dot
node ../build/src/main.js example.s > example.result.s

echo "DONE!"
echo "Graph before transformation example.orig.dot"
echo "Graph after transformation example.transformed.dot"
echo "Result assembly code example.result.s"
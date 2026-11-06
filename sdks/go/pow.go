package dominusnode

import (
	"crypto/sha256"
	"math/bits"
	"strconv"
)

// DefaultMaxPowIterations caps the node-registration PoW search.
const DefaultMaxPowIterations = 200_000_000

func leadingZeroBits(b []byte) int {
	n := 0
	for _, x := range b {
		if x == 0 {
			n += 8
			continue
		}
		return n + bits.LeadingZeros8(x)
	}
	return n
}

// SolvePow finds the smallest n >= 0 such that sha256(prefix + decimal(n)) has
// at least difficulty leading zero bits.
func SolvePow(prefix string, difficulty, maxIterations int) (string, error) {
	if len(prefix) == 0 || len(prefix) > 256 {
		return "", protocolErr("invalid PoW prefix")
	}
	if difficulty < 1 || difficulty > 32 {
		return "", protocolErr("invalid PoW difficulty")
	}
	buf := make([]byte, 0, len(prefix)+20)
	for n := 0; n < maxIterations; n++ {
		buf = strconv.AppendInt(append(buf[:0], prefix...), int64(n), 10)
		h := sha256.Sum256(buf)
		if leadingZeroBits(h[:]) >= difficulty {
			return strconv.Itoa(n), nil
		}
	}
	return "", protocolErr("PoW not solved within iteration cap")
}

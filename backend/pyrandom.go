package main

// Python の random.Random（メルセンヌ・ツイスタ MT19937）の移植。seed_history が、文字列の種（"20261121:customer:1" など）から、
// Python と同じ乱数列でダミーの履歴を作るために使う（Python が作ったデータと同じ中身になる）。
//   - 種: 文字列（str）は、UTF-8 のバイト列に sha512 を連結して、大きな整数にしてから init_by_array（version 2）
//   - random(): 53 ビットの小数。getrandbits(k)・randint・choice・choices・sample・gauss は、CPython 3.13 のアルゴリズムと同じ
// 三角関数・対数は Go の math（Python は C ライブラリ）。最後の 1 ビットが違う入力は、まれに積分値（int(gauss)）の境目で違いうる。

import (
	"crypto/sha512"
	"math"
	"math/big"
	"sort"
)

const (
	mtN         = 624
	mtM         = 397
	mtMatrixA   = 0x9908b0df
	mtUpperMask = 0x80000000
	mtLowerMask = 0x7fffffff
)

type pyRandom struct {
	mt        [mtN]uint32
	index     int
	gaussNext float64
	hasGauss  bool
}

func (r *pyRandom) initGenrand(s uint32) {
	r.mt[0] = s
	for i := 1; i < mtN; i++ {
		r.mt[i] = 1812433253*(r.mt[i-1]^(r.mt[i-1]>>30)) + uint32(i)
	}
	r.index = mtN
}

func (r *pyRandom) initByArray(key []uint32) {
	r.initGenrand(19650218)
	i, j := 1, 0
	k := mtN
	if len(key) > k {
		k = len(key)
	}
	for ; k > 0; k-- {
		r.mt[i] = (r.mt[i] ^ ((r.mt[i-1] ^ (r.mt[i-1] >> 30)) * 1664525)) + key[j] + uint32(j)
		i++
		j++
		if i >= mtN {
			r.mt[0] = r.mt[mtN-1]
			i = 1
		}
		if j >= len(key) {
			j = 0
		}
	}
	for k = mtN - 1; k > 0; k-- {
		r.mt[i] = (r.mt[i] ^ ((r.mt[i-1] ^ (r.mt[i-1] >> 30)) * 1566083941)) - uint32(i)
		i++
		if i >= mtN {
			r.mt[0] = r.mt[mtN-1]
			i = 1
		}
	}
	r.mt[0] = 0x80000000
	r.index = mtN
}

// newPyRandom は random.Random(str) と同じ状態にする。
func newPyRandom(seed string) *pyRandom {
	b := []byte(seed)
	sum := sha512.Sum512(b)
	b = append(b, sum[:]...)
	n := new(big.Int).SetBytes(b) // int.from_bytes(b, 'big')
	// 32 ビットずつ、下位から
	var key []uint32
	mask := new(big.Int).SetUint64(0xffffffff)
	for n.Sign() > 0 {
		key = append(key, uint32(new(big.Int).And(n, mask).Uint64()))
		n.Rsh(n, 32)
	}
	if len(key) == 0 {
		key = []uint32{0}
	}
	r := &pyRandom{}
	r.initByArray(key)
	return r
}

func (r *pyRandom) genrandUint32() uint32 {
	if r.index >= mtN {
		var kk int
		mag := [2]uint32{0, mtMatrixA}
		for kk = 0; kk < mtN-mtM; kk++ {
			y := (r.mt[kk] & mtUpperMask) | (r.mt[kk+1] & mtLowerMask)
			r.mt[kk] = r.mt[kk+mtM] ^ (y >> 1) ^ mag[y&1]
		}
		for ; kk < mtN-1; kk++ {
			y := (r.mt[kk] & mtUpperMask) | (r.mt[kk+1] & mtLowerMask)
			r.mt[kk] = r.mt[kk+(mtM-mtN)] ^ (y >> 1) ^ mag[y&1]
		}
		y := (r.mt[mtN-1] & mtUpperMask) | (r.mt[0] & mtLowerMask)
		r.mt[mtN-1] = r.mt[mtM-1] ^ (y >> 1) ^ mag[y&1]
		r.index = 0
	}
	y := r.mt[r.index]
	r.index++
	y ^= y >> 11
	y ^= (y << 7) & 0x9d2c5680
	y ^= (y << 15) & 0xefc60000
	y ^= y >> 18
	return y
}

// random は [0, 1) の小数（53 ビット）。
func (r *pyRandom) random() float64 {
	a := r.genrandUint32() >> 5
	b := r.genrandUint32() >> 6
	return (float64(a)*67108864.0 + float64(b)) * (1.0 / 9007199254740992.0)
}

// getrandbits は k ビットの整数（k <= 64 の範囲。ここでは 1〜32 しか使わない）。
func (r *pyRandom) getrandbits(k int) uint64 {
	if k <= 32 {
		return uint64(r.genrandUint32() >> uint(32-k))
	}
	var out uint64
	shift := 0
	for k > 0 {
		w := r.genrandUint32()
		if k < 32 {
			w >>= uint(32 - k)
		}
		out |= uint64(w) << uint(shift)
		shift += 32
		k -= 32
	}
	return out
}

func bitLength(n uint64) int {
	l := 0
	for n > 0 {
		l++
		n >>= 1
	}
	return l
}

// randbelow は [0, n) の整数（CPython の _randbelow_with_getrandbits）。
func (r *pyRandom) randbelow(n int) int {
	if n <= 0 {
		return 0
	}
	k := bitLength(uint64(n))
	v := r.getrandbits(k)
	for v >= uint64(n) {
		v = r.getrandbits(k)
	}
	return int(v)
}

// randint は a 以上 b 以下の整数。
func (r *pyRandom) randint(a, b int) int { return a + r.randbelow(b-a+1) }

// choiceIndex は choice(seq) の添字。
func (r *pyRandom) choiceIndex(n int) int { return r.randbelow(n) }

// choicesIndex は choices(population, weights=weights)[0] の添字（cum_weights の二分探索。bisect_right）。
func (r *pyRandom) choicesIndex(weights []int) int {
	cum := make([]int, len(weights))
	total := 0
	for i, w := range weights {
		total += w
		cum[i] = total
	}
	x := r.random() * (float64(cum[len(cum)-1]) + 0.0)
	hi := len(cum) - 1
	// bisect_right(cum, x, 0, hi)
	return sort.Search(hi, func(i int) bool { return float64(cum[i]) > x })
}

// sample は population（長さ n）から k 個の添字（CPython の sample）。順序も同じ。
func (r *pyRandom) sample(n, k int) []int {
	setsize := 21
	if k > 5 {
		setsize += pow4Ceil(k * 3)
	}
	result := make([]int, k)
	if n <= setsize {
		pool := make([]int, n)
		for i := range pool {
			pool[i] = i
		}
		for i := 0; i < k; i++ {
			j := r.randbelow(n - i)
			result[i] = pool[j]
			pool[j] = pool[n-i-1]
		}
		return result
	}
	selected := map[int]bool{}
	for i := 0; i < k; i++ {
		j := r.randbelow(n)
		for selected[j] {
			j = r.randbelow(n)
		}
		selected[j] = true
		result[i] = j
	}
	return result
}

// pow4Ceil は 4 ** ceil(log(x, 4))。
func pow4Ceil(x int) int {
	c := int(math.Ceil(math.Log(float64(x)) / math.Log(4)))
	p := 1
	for i := 0; i < c; i++ {
		p *= 4
	}
	return p
}

// gauss は正規分布（CPython 3.12 以降の実装。2 つ目の値を次に回す）。
func (r *pyRandom) gauss(mu, sigma float64) float64 {
	z := r.gaussNext
	has := r.hasGauss
	r.hasGauss = false
	if !has {
		x2pi := r.random() * (2 * math.Pi)
		g2rad := math.Sqrt(-2.0 * math.Log(1.0-r.random()))
		z = math.Cos(x2pi) * g2rad
		r.gaussNext = math.Sin(x2pi) * g2rad
		r.hasGauss = true
	}
	return mu + z*sigma
}

package main

// Python との数値の表記・丸めの合わせ。
//   - pyFloat: JSON の小数。Python の repr と同じく、整数の値にも ".0" を付ける（12.0）
//   - pyRound: round(x, n)。Python は、2 進の正確な値を 10 進に丸める（半分は偶数）。strconv の 'f' も同じ

import (
	"math"
	"strconv"
	"strings"
)

type pyFloat float64

func (f pyFloat) MarshalJSON() ([]byte, error) {
	x := float64(f)
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return []byte("null"), nil
	}
	s := strconv.FormatFloat(x, 'f', -1, 64)
	if !strings.Contains(s, ".") {
		s += ".0"
	}
	return []byte(s), nil
}

// pyRound は round(x, ndigits)（小数）。
func pyRound(x float64, ndigits int) float64 {
	s := strconv.FormatFloat(x, 'f', ndigits, 64)
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

// pyRoundInt は round(x)（整数へ。半分は偶数）。
func pyRoundInt(x float64) int { return int(math.RoundToEven(x)) }

func pyFloatPtr(x *float64) *pyFloat {
	if x == nil {
		return nil
	}
	f := pyFloat(*x)
	return &f
}

func f64(x float64) *float64 { return &x }

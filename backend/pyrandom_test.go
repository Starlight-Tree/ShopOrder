package main

import (
	"math"
	"testing"
)

// Python（random.Random(str)）の値と同じ乱数が出ること。期待値は Python 3 で取った実測。
func TestPyRandomMatchesPython(t *testing.T) {
	r := newPyRandom("20261121:customer:1")
	for i, want := range []float64{0.8461578549386696, 0.7134216026486774, 0.7029129917848252} {
		if got := r.random(); got != want {
			t.Fatalf("random %d: got %v want %v", i, got, want)
		}
	}
	if got := r.randint(15, 28); got != 16 {
		t.Fatalf("randint: got %d want 16", got)
	}
	// choices([1,2,3], weights=[60,30,10])[0] → 1
	if got := []int{1, 2, 3}[r.choicesIndex([]int{60, 30, 10})]; got != 1 {
		t.Fatalf("choices: got %d want 1", got)
	}
	got := r.sample(5, 2) // sample(range(5), 2) → [4, 1]
	if got[0] != 4 || got[1] != 1 {
		t.Fatalf("sample: got %v want [4 1]", got)
	}
	if g := r.gauss(500, 50); math.Abs(g-522.2147290287882) > 1e-9 {
		t.Fatalf("gauss 1: got %v", g)
	}
	if g := r.gauss(500, 50); math.Abs(g-552.8571165622849) > 1e-9 {
		t.Fatalf("gauss 2: got %v", g)
	}
	if got := r.randint(3, 8); got != 6 {
		t.Fatalf("randint 2: got %d want 6", got)
	}

	r2 := newPyRandom("20261121:visit:5:2026-09-01:0")
	if a, b := r2.random(), r2.random(); a != 0.3565422819004891 || b != 0.697379161925599 {
		t.Fatalf("visit random: %v %v", a, b)
	}
	// sample(sorted(15 items), 2) → ['i', 'm'] = 添字 8, 12
	if got := r2.sample(15, 2); got[0] != 8 || got[1] != 12 {
		t.Fatalf("sample 15: got %v want [8 12]", got)
	}
}

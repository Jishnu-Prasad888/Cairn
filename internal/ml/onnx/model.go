package onnx

import (
	"fmt"
	"math"
	"os"
	"runtime"
	"sync"
)

// Tensor is a dense float32 tensor in row-major (NCHW) layout.
type Tensor struct {
	Shape []int
	Data  []float32
}

func newTensor(shape ...int) *Tensor {
	n := 1
	for _, d := range shape {
		n *= d
	}
	return &Tensor{Shape: shape, Data: make([]float32, n)}
}

// Model is a loaded, validated network. Run is safe for concurrent use.
type Model struct {
	g      *graphProto
	input  string
	output string
}

var supported = map[string]bool{
	"Conv": true, "PRelu": true, "Add": true, "BatchNormalization": true,
	"Flatten": true, "Gemm": true, "Relu": true,
}

// Load reads an ONNX file.
func Load(path string) (*Model, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(b)
}

// Parse decodes an ONNX model and rejects unsupported operators up front.
func Parse(b []byte) (m *Model, err error) {
	defer func() {
		if r := recover(); r != nil {
			m, err = nil, fmt.Errorf("onnx: malformed model: %v", r)
		}
	}()
	g, err := parseModel(b)
	if err != nil {
		return nil, err
	}
	for _, n := range g.nodes {
		if !supported[n.op] {
			return nil, fmt.Errorf("onnx: unsupported operator %q", n.op)
		}
	}
	var in []string
	for _, name := range g.inputs {
		if _, isWeight := g.inits[name]; !isWeight {
			in = append(in, name)
		}
	}
	if len(in) != 1 || len(g.outputs) != 1 {
		return nil, fmt.Errorf("onnx: want 1 input and 1 output, got %d and %d", len(in), len(g.outputs))
	}
	return &Model{g: g, input: in[0], output: g.outputs[0]}, nil
}

// Run executes the network on one input and returns its output tensor.
func (m *Model) Run(in *Tensor) (out *Tensor, err error) {
	defer func() {
		if r := recover(); r != nil {
			out, err = nil, fmt.Errorf("onnx: run failed: %v", r)
		}
	}()
	vals := map[string]*Tensor{m.input: in}
	get := func(name string) *Tensor {
		if t, ok := vals[name]; ok {
			return t
		}
		if w, ok := m.g.inits[name]; ok {
			t := &Tensor{Shape: w.dims, Data: w.f32}
			vals[name] = t
			return t
		}
		panic("missing value " + name)
	}
	for _, n := range m.g.nodes {
		var r *Tensor
		switch n.op {
		case "Conv":
			var bias *Tensor
			if len(n.inputs) > 2 {
				bias = get(n.inputs[2])
			}
			r = conv(get(n.inputs[0]), get(n.inputs[1]), bias, n)
		case "PRelu":
			r = prelu(get(n.inputs[0]), get(n.inputs[1]))
		case "Relu":
			r = relu(get(n.inputs[0]))
		case "Add":
			r = add(get(n.inputs[0]), get(n.inputs[1]))
		case "BatchNormalization":
			r = batchNorm(get(n.inputs[0]), get(n.inputs[1]), get(n.inputs[2]),
				get(n.inputs[3]), get(n.inputs[4]), n)
		case "Flatten":
			r = flatten(get(n.inputs[0]), n)
		case "Gemm":
			var c *Tensor
			if len(n.inputs) > 2 {
				c = get(n.inputs[2])
			}
			r = gemm(get(n.inputs[0]), get(n.inputs[1]), c, n)
		}
		vals[n.outputs[0]] = r
	}
	res, ok := vals[m.output]
	if !ok {
		return nil, fmt.Errorf("onnx: output %q was not produced", m.output)
	}
	return res, nil
}

func (a *attr) intsOr(def ...int) []int {
	if a == nil || len(a.ints) == 0 {
		return def
	}
	out := make([]int, len(a.ints))
	for i, v := range a.ints {
		out[i] = int(v)
	}
	return out
}

func parallel(n int, fn func(i int)) {
	w := runtime.GOMAXPROCS(0)
	if w > n {
		w = n
	}
	var wg sync.WaitGroup
	next := make(chan int, n)
	for i := 0; i < n; i++ {
		next <- i
	}
	close(next)
	for k := 0; k < w; k++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				fn(i)
			}
		}()
	}
	wg.Wait()
}

func conv(x, w, bias *Tensor, n *nodeProto) *Tensor {
	N, C, H, W := x.Shape[0], x.Shape[1], x.Shape[2], x.Shape[3]
	M, cg, kh, kw := w.Shape[0], w.Shape[1], w.Shape[2], w.Shape[3]
	group := 1
	if a := n.attrs["group"]; a != nil {
		group = int(a.i)
	}
	st := n.attrs["strides"].intsOr(1, 1)
	pad := n.attrs["pads"].intsOr(0, 0, 0, 0)
	dil := n.attrs["dilations"].intsOr(1, 1)
	if cg*group != C || M%group != 0 {
		panic("conv: channel/group mismatch")
	}
	oh := (H+pad[0]+pad[2]-dil[0]*(kh-1)-1)/st[0] + 1
	ow := (W+pad[1]+pad[3]-dil[1]*(kw-1)-1)/st[1] + 1
	out := newTensor(N, M, oh, ow)
	mg := M / group
	for b := 0; b < N; b++ {
		parallel(M, func(m int) {
			g := m / mg
			dst := out.Data[(b*M+m)*oh*ow : (b*M+m+1)*oh*ow]
			if bias != nil {
				for i := range dst {
					dst[i] = bias.Data[m]
				}
			}
			for c := 0; c < cg; c++ {
				src := x.Data[(b*C+g*cg+c)*H*W : (b*C+g*cg+c+1)*H*W]
				wk := w.Data[((m*cg+c)*kh)*kw : ((m*cg+c)*kh+kh)*kw]
				for ky := 0; ky < kh; ky++ {
					for kx := 0; kx < kw; kx++ {
						wv := wk[ky*kw+kx]
						if wv == 0 {
							continue
						}
						for y := 0; y < oh; y++ {
							iy := y*st[0] - pad[0] + ky*dil[0]
							if iy < 0 || iy >= H {
								continue
							}
							row := src[iy*W : (iy+1)*W]
							drow := dst[y*ow : (y+1)*ow]
							ix := -pad[1] + kx*dil[1]
							for xx := 0; xx < ow; xx++ {
								if ix >= 0 && ix < W {
									drow[xx] += wv * row[ix]
								}
								ix += st[1]
							}
						}
					}
				}
			}
		})
	}
	return out
}

func prelu(x, slope *Tensor) *Tensor {
	out := newTensor(x.Shape...)
	per := 1 // elements sharing one slope
	if len(slope.Data) > 1 && len(x.Shape) == 4 {
		per = x.Shape[2] * x.Shape[3]
	}
	for i, v := range x.Data {
		if v < 0 {
			s := slope.Data[0]
			if len(slope.Data) > 1 {
				s = slope.Data[(i/per)%len(slope.Data)]
			}
			v *= s
		}
		out.Data[i] = v
	}
	return out
}

func relu(x *Tensor) *Tensor {
	out := newTensor(x.Shape...)
	for i, v := range x.Data {
		if v > 0 {
			out.Data[i] = v
		}
	}
	return out
}

func add(a, b *Tensor) *Tensor {
	if len(a.Data) < len(b.Data) {
		a, b = b, a
	}
	out := newTensor(a.Shape...)
	switch {
	case len(a.Data) == len(b.Data):
		for i := range a.Data {
			out.Data[i] = a.Data[i] + b.Data[i]
		}
	case len(a.Shape) == 4 && len(b.Data) == a.Shape[1]:
		per := a.Shape[2] * a.Shape[3]
		for i := range a.Data {
			out.Data[i] = a.Data[i] + b.Data[(i/per)%a.Shape[1]]
		}
	case len(b.Data) == 1:
		for i := range a.Data {
			out.Data[i] = a.Data[i] + b.Data[0]
		}
	default:
		panic("add: unsupported broadcast")
	}
	return out
}

func batchNorm(x, scale, bias, mean, variance *Tensor, n *nodeProto) *Tensor {
	eps := float32(1e-5)
	if a := n.attrs["epsilon"]; a != nil {
		eps = a.f
	}
	C := x.Shape[1]
	per := len(x.Data) / (x.Shape[0] * C)
	out := newTensor(x.Shape...)
	for i, v := range x.Data {
		c := (i / per) % C
		inv := scale.Data[c] / float32(math.Sqrt(float64(variance.Data[c]+eps)))
		out.Data[i] = (v-mean.Data[c])*inv + bias.Data[c]
	}
	return out
}

func flatten(x *Tensor, n *nodeProto) *Tensor {
	axis := 1
	if a := n.attrs["axis"]; a != nil {
		axis = int(a.i)
	}
	rows := 1
	for _, d := range x.Shape[:axis] {
		rows *= d
	}
	return &Tensor{Shape: []int{rows, len(x.Data) / rows}, Data: x.Data}
}

func gemm(a, b, c *Tensor, n *nodeProto) *Tensor {
	alpha, beta := float32(1), float32(1)
	var transA, transB bool
	if x := n.attrs["alpha"]; x != nil {
		alpha = x.f
	}
	if x := n.attrs["beta"]; x != nil {
		beta = x.f
	}
	if x := n.attrs["transA"]; x != nil {
		transA = x.i != 0
	}
	if x := n.attrs["transB"]; x != nil {
		transB = x.i != 0
	}
	M, K := a.Shape[0], a.Shape[1]
	if transA {
		M, K = K, M
	}
	N := b.Shape[1]
	if transB {
		N = b.Shape[0]
	}
	out := newTensor(M, N)
	at := func(i, k int) float32 {
		if transA {
			return a.Data[k*M+i]
		}
		return a.Data[i*K+k]
	}
	bt := func(k, j int) float32 {
		if transB {
			return b.Data[j*K+k]
		}
		return b.Data[k*N+j]
	}
	for i := 0; i < M; i++ {
		for j := 0; j < N; j++ {
			var s float32
			for k := 0; k < K; k++ {
				s += at(i, k) * bt(k, j)
			}
			s *= alpha
			if c != nil {
				switch {
				case len(c.Data) == N:
					s += beta * c.Data[j]
				case len(c.Data) == M*N:
					s += beta * c.Data[i*N+j]
				default:
					s += beta * c.Data[0]
				}
			}
			out.Data[i*N+j] = s
		}
	}
	return out
}

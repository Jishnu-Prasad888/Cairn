package metadata

import (
	"image"
	"image/color"
)

// boxShrink reduces src by the whole factor k, each output pixel the mean of
// a k×k block of source pixels (a trailing partial block is dropped). It
// works on the pixel buffers directly, so it is about as fast as reading the
// image once. Only the layouts decoders produce for photos are handled
// (JPEG's YCbCr and Gray, and RGBA/NRGBA); for anything else it returns nil
// and the caller resamples the original.
func boxShrink(src image.Image, k int) image.Image {
	b := src.Bounds()
	w, h := b.Dx()/k, b.Dy()/k
	if w < 1 || h < 1 {
		return nil
	}
	n := uint32(k * k)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))

	switch s := src.(type) {
	case *image.YCbCr:
		for oy := 0; oy < h; oy++ {
			for ox := 0; ox < w; ox++ {
				var ys, cbs, crs uint32
				for dy := 0; dy < k; dy++ {
					y := b.Min.Y + oy*k + dy
					yRow := s.Y[s.YOffset(b.Min.X+ox*k, y):]
					for dx := 0; dx < k; dx++ {
						ys += uint32(yRow[dx])
						ci := s.COffset(b.Min.X+ox*k+dx, y)
						cbs += uint32(s.Cb[ci])
						crs += uint32(s.Cr[ci])
					}
				}
				r, g, bl := color.YCbCrToRGB(uint8(ys/n), uint8(cbs/n), uint8(crs/n))
				i := dst.PixOffset(ox, oy)
				dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2], dst.Pix[i+3] = r, g, bl, 0xff
			}
		}
	case *image.Gray:
		for oy := 0; oy < h; oy++ {
			for ox := 0; ox < w; ox++ {
				var sum uint32
				for dy := 0; dy < k; dy++ {
					row := s.Pix[s.PixOffset(b.Min.X+ox*k, b.Min.Y+oy*k+dy):]
					for dx := 0; dx < k; dx++ {
						sum += uint32(row[dx])
					}
				}
				v := uint8(sum / n)
				i := dst.PixOffset(ox, oy)
				dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2], dst.Pix[i+3] = v, v, v, 0xff
			}
		}
	case *image.RGBA:
		shrinkRGBA(dst, s.Pix, s.Stride, s.PixOffset(b.Min.X, b.Min.Y), k, false)
	case *image.NRGBA:
		shrinkRGBA(dst, s.Pix, s.Stride, s.PixOffset(b.Min.X, b.Min.Y), k, true)
	default:
		return nil
	}
	return dst
}

// shrinkRGBA box-filters 4-byte pixels starting at offset base into dst.
// Non-premultiplied input is premultiplied as it is averaged, so transparent
// pixels do not bleed their colour into the result.
func shrinkRGBA(dst *image.RGBA, pix []uint8, stride, base, k int, straight bool) {
	b := dst.Bounds()
	n := uint32(k * k)
	for oy := 0; oy < b.Dy(); oy++ {
		for ox := 0; ox < b.Dx(); ox++ {
			var rs, gs, bs, as uint32
			for dy := 0; dy < k; dy++ {
				row := pix[base+(oy*k+dy)*stride+ox*k*4:]
				for dx := 0; dx < k*4; dx += 4 {
					r, g, bl, a := uint32(row[dx]), uint32(row[dx+1]), uint32(row[dx+2]), uint32(row[dx+3])
					if straight {
						r, g, bl = r*a/0xff, g*a/0xff, bl*a/0xff
					}
					rs, gs, bs, as = rs+r, gs+g, bs+bl, as+a
				}
			}
			i := dst.PixOffset(ox, oy)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2], dst.Pix[i+3] =
				uint8(rs/n), uint8(gs/n), uint8(bs/n), uint8(as/n)
		}
	}
}

# XMP fixtures

`darktable-unrated.xmp` is an unmodified copy of darktable's
`src/tests/benchmark/darktable-bench-null.xmp` at commit
`ea71598964d50dc888c02df10517287444fc21b9`.
It contains an actual Exiv2 document, an unrated photo, source identity, and
processing history. The upstream license is included as `LICENSE.darktable`.
Source: https://github.com/darktable-org/darktable/blob/ea71598964d50dc888c02df10517287444fc21b9/src/tests/benchmark/darktable-bench-null.xmp

The unit tests derive rejected, starred, and color-labelled cases from that
fixture. Those variants exercise the writer's documented fields; they are not
claimed to be exports from a running darktable instance.

The source checkout used to verify the format writes `xmp:Rating` using
`dt_image_get_xmp_rating_from_flags` in `src/common/image.c`, lines 600–625,
called by `src/common/exif.cc`, lines 5185–5187. Rejection is `-1`; stars are
`0` through `5`. The color sequence writer is in `exif.cc`, lines 5106–5123.
Duplicate filename suffixes are inserted before the image extension by
`dt_image_path_append_version_no_db`, then `.xmp` is appended.

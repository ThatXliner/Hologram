#!/usr/bin/env python3
"""
Convert DnCNN grayscale blind denoiser from KAIR (PyTorch) to ONNX.

Usage:
    pip install torch onnx
    python scripts/convert_dncnn_to_onnx.py

Downloads dncnn_gray_blind.pth from cszn/KAIR and exports to
src-tauri/resources/dncnn_gray_blind.onnx with dynamic spatial dims.
"""

import os
import urllib.request
import torch
import torch.nn as nn

# --- DnCNN architecture (matches KAIR's network_dncnn.py) ---

class DnCNN(nn.Module):
    def __init__(self, in_nc=1, out_nc=1, nc=64, nb=20):
        super().__init__()
        layers = []
        # First layer: Conv + ReLU
        layers.append(nn.Conv2d(in_nc, nc, 3, padding=1, bias=True))
        layers.append(nn.ReLU(inplace=True))
        # Middle layers: Conv + ReLU (KAIR blind model has no BN, all biased)
        for _ in range(nb - 2):
            layers.append(nn.Conv2d(nc, nc, 3, padding=1, bias=True))
            layers.append(nn.ReLU(inplace=True))
        # Last layer: Conv
        layers.append(nn.Conv2d(nc, out_nc, 3, padding=1, bias=True))
        self.model = nn.Sequential(*layers)

    def forward(self, x):
        # DnCNN predicts the noise residual, output = input - noise
        return x - self.model(x)


WEIGHTS_URL = "https://github.com/cszn/KAIR/releases/download/v1.0/dncnn_gray_blind.pth"
WEIGHTS_PATH = "scripts/dncnn_gray_blind.pth"
OUTPUT_PATH = "src-tauri/resources/dncnn_gray_blind.onnx"


def main():
    # Download weights if not cached
    if not os.path.exists(WEIGHTS_PATH):
        print(f"Downloading weights from {WEIGHTS_URL}...")
        urllib.request.urlretrieve(WEIGHTS_URL, WEIGHTS_PATH)
        print(f"Saved to {WEIGHTS_PATH}")

    # Build model and load weights
    model = DnCNN(in_nc=1, out_nc=1, nc=64, nb=20)
    state_dict = torch.load(WEIGHTS_PATH, map_location="cpu", weights_only=True)
    model.load_state_dict(state_dict, strict=True)
    model.eval()

    # Export to ONNX with dynamic spatial dimensions
    dummy = torch.randn(1, 1, 256, 256)
    torch.onnx.export(
        model,
        dummy,
        OUTPUT_PATH,
        opset_version=11,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "output": {0: "batch", 2: "height", 3: "width"},
        },
    )

    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"Exported to {OUTPUT_PATH} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()

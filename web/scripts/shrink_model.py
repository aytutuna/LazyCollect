"""Makes the page corner model a quarter of its size for the phone download.

Reads DocAligner's fp32 FastViT-T8 and stores each convolution's weights as int8 with one scale per output channel,
followed by a DequantizeLinear node. The arithmetic stays fp32 (the runtime folds the dequantized weights back when it
loads the model), so the heatmaps stay close to the original; dynamic quantization of the activations was tried and
flattened them. Usage: python shrink_model.py <fp32.onnx> <out.onnx>. Needs onnx and numpy (see scripts/requirements.txt).
"""
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

MIN_SIZE = 1024


def shrink(src, dst):
    model = onnx.load(src)
    graph = model.graph
    weights = {i.name: i for i in graph.initializer}
    convs = [n for n in graph.node if n.op_type == "Conv" and n.input[1] in weights and weights[n.input[1]].data_type == TensorProto.FLOAT]
    done = set()
    added = []
    for node in convs:
        name = node.input[1]
        w = numpy_helper.to_array(weights[name])
        if name in done or w.size < MIN_SIZE:
            continue
        done.add(name)
        flat = w.reshape(w.shape[0], -1)
        scale = np.maximum(np.abs(flat).max(axis=1) / 127.0, 1e-12).astype(np.float32)
        q = np.clip(np.round(flat / scale[:, None]), -127, 127).astype(np.int8).reshape(w.shape)
        graph.initializer.remove(weights[name])
        graph.initializer.append(numpy_helper.from_array(q, name + "_q"))
        graph.initializer.append(numpy_helper.from_array(scale, name + "_scale"))
        graph.initializer.append(numpy_helper.from_array(np.zeros(len(scale), dtype=np.int8), name + "_zero"))
        added.append(helper.make_node("DequantizeLinear", [name + "_q", name + "_scale", name + "_zero"], [name], name=name + "_dq", axis=0))
    # the new nodes come first so every consumer sees its weights defined
    for node in reversed(added):
        graph.node.insert(0, node)
    onnx.save(model, dst + ".part")
    os.replace(dst + ".part", dst)
    return len(done)


if __name__ == "__main__":
    print(f"{shrink(sys.argv[1], sys.argv[2])} convolutions stored as int8")

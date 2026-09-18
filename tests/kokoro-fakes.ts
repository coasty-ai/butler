/**
 * Fakes shared by the Kokoro tests: a zero-weight BART whose output is
 * decided by final_logits_bias alone, in the file shapes the engine reads.
 * Not a test file itself (vitest runs tests/**\/*.test.ts).
 */

export interface TinyBartFiles {
  config: Uint8Array;
  safetensors: Uint8Array;
  configJson: {
    d_model: number;
    max_position_embeddings: number;
    grapheme_chars: string;
    phoneme_chars: string;
  };
}

/** `bias` has one entry per phoneme symbol (pad, bos, eos, unk, then real). */
export function tinyBart(
  bias: number[],
  chars = { grapheme_chars: "____abcd", phoneme_chars: "____xy" },
): TinyBartFiles {
  const d = 2;
  const tensors = new Map<string, [number[], number[]]>();
  const put = (name: string, shape: number[], values?: number[]) =>
    tensors.set(name, [
      shape,
      values ?? new Array(shape.reduce((a, b) => a * b, 1)).fill(0),
    ]);
  put("model.shared.weight", [bias.length, d]);
  put("final_logits_bias", [1, bias.length], bias);
  for (const stack of ["encoder", "decoder"]) {
    const layer = `model.${stack}.layers.0`;
    const norms = [
      `model.${stack}.layernorm_embedding`,
      `${layer}.self_attn_layer_norm`,
      `${layer}.final_layer_norm`,
    ];
    const attentions = [`${layer}.self_attn`];
    if (stack === "decoder") {
      norms.push(`${layer}.encoder_attn_layer_norm`);
      attentions.push(`${layer}.encoder_attn`);
    }
    put(`model.${stack}.embed_positions.weight`, [10, d]);
    for (const norm of norms) {
      put(`${norm}.weight`, [d]);
      put(`${norm}.bias`, [d]);
    }
    for (const attention of attentions)
      for (const projection of ["q_proj", "k_proj", "v_proj", "out_proj"]) {
        put(`${attention}.${projection}.weight`, [d, d]);
        put(`${attention}.${projection}.bias`, [d]);
      }
    put(`${layer}.fc1.weight`, [4, d]);
    put(`${layer}.fc1.bias`, [4]);
    put(`${layer}.fc2.weight`, [d, 4]);
    put(`${layer}.fc2.bias`, [d]);
  }
  const header: Record<string, unknown> = {};
  let size = 0;
  for (const [name, [shape, values]] of tensors) {
    header[name] = {
      dtype: "F32",
      shape,
      data_offsets: [size, size + values.length * 4],
    };
    size += values.length * 4;
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(8 + json.length + size);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(json.length), true);
  bytes.set(json, 8);
  let at = 8 + json.length;
  for (const [, values] of tensors.values()) {
    bytes.set(new Uint8Array(Float32Array.from(values).buffer), at);
    at += values.length * 4;
  }
  const configJson = { d_model: d, max_position_embeddings: 10, ...chars };
  return {
    config: new TextEncoder().encode(JSON.stringify(configJson)),
    safetensors: bytes,
    configJson,
  };
}

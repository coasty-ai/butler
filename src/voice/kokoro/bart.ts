/**
 * Greedy decoder for PeterReid/graphemes_to_phonemes_en_us (Apache-2.0), the
 * tiny BART (1 encoder layer, 1 decoder layer, d_model 128, 1 head, ~3 MB)
 * that misaki uses as its non-espeak fallback for words outside the lexicon.
 * Dependency-free: the caller passes config.json and model.safetensors bytes.
 */

export interface BartConfig {
  d_model: number;
  max_position_embeddings: number;
  grapheme_chars: string;
  phoneme_chars: string;
  encoder_layers?: number;
  decoder_layers?: number;
  encoder_attention_heads?: number;
  decoder_attention_heads?: number;
  activation_function?: string;
}

export interface BartTensor {
  shape: number[];
  data: Float32Array;
}

const BOS = 1;
const EOS = 2;
const UNKNOWN = 3;
/** BART's learned position embeddings start at offset 2. */
const POSITION_OFFSET = 2;

/** Parses a float32-only safetensors file. */
export function parseSafetensors(bytes: Uint8Array): Map<string, BartTensor> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8) throw new Error("safetensors file is truncated");
  const headerLength = Number(view.getBigUint64(0, true));
  if (headerLength <= 0 || 8 + headerLength > bytes.byteLength)
    throw new Error("safetensors header is malformed");
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)),
  ) as Record<
    string,
    { dtype?: string; shape?: number[]; data_offsets?: [number, number] }
  >;
  const base = 8 + headerLength;
  const tensors = new Map<string, BartTensor>();
  for (const [name, meta] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    if (meta.dtype !== "F32")
      throw new Error(`unsupported safetensors dtype ${meta.dtype}`);
    const [start, end] = meta.data_offsets ?? [0, -1];
    const shape = meta.shape ?? [];
    const count = shape.reduce((a, b) => a * b, 1);
    if (end - start !== count * 4 || base + end > bytes.byteLength)
      throw new Error("safetensors tensor is out of bounds");
    // Copy so the tensor is aligned and independent of the file buffer.
    const data = new Float32Array(count);
    new Uint8Array(data.buffer).set(bytes.subarray(base + start, base + end));
    tensors.set(name, { shape, data });
  }
  return tensors;
}

type Weights = { weight: BartTensor; bias: BartTensor };

function linear(
  x: Float32Array,
  steps: number,
  { weight, bias }: Weights,
): Float32Array {
  const [outputs, inputs] = weight.shape;
  const w = weight.data;
  const b = bias.data;
  const y = new Float32Array(steps * outputs);
  for (let t = 0; t < steps; t++) {
    const xo = t * inputs;
    const yo = t * outputs;
    for (let o = 0; o < outputs; o++) {
      let sum = b[o];
      const wo = o * inputs;
      for (let i = 0; i < inputs; i++) sum += w[wo + i] * x[xo + i];
      y[yo + o] = sum;
    }
  }
  return y;
}

function layerNorm(
  x: Float32Array,
  steps: number,
  size: number,
  { weight, bias }: Weights,
  eps = 1e-5,
): Float32Array {
  const y = new Float32Array(steps * size);
  for (let t = 0; t < steps; t++) {
    const o = t * size;
    let mean = 0;
    for (let i = 0; i < size; i++) mean += x[o + i];
    mean /= size;
    let variance = 0;
    for (let i = 0; i < size; i++) {
      const d = x[o + i] - mean;
      variance += d * d;
    }
    const inv = 1 / Math.sqrt(variance / size + eps);
    for (let i = 0; i < size; i++)
      y[o + i] = (x[o + i] - mean) * inv * weight.data[i] + bias.data[i];
  }
  return y;
}

// Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7): enough for exact-GELU parity.
function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}
const gelu = (x: number) => 0.5 * x * (1 + erf(x / Math.SQRT2));

function add(a: Float32Array, b: Float32Array): Float32Array {
  const y = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) y[i] = a[i] + b[i];
  return y;
}

interface Attention {
  q_proj: Weights;
  k_proj: Weights;
  v_proj: Weights;
  out_proj: Weights;
}
interface Layer {
  self_attn: Attention;
  self_attn_layer_norm: Weights;
  encoder_attn?: Attention;
  encoder_attn_layer_norm?: Weights;
  fc1: Weights;
  fc2: Weights;
  final_layer_norm: Weights;
}
interface Stack {
  embed_positions: { weight: BartTensor };
  layernorm_embedding: Weights;
  layers: Layer[];
}

function attention(
  p: Attention,
  query: Float32Array,
  queries: number,
  memory: Float32Array,
  keys: number,
  size: number,
  causal: boolean,
): Float32Array {
  const q = linear(query, queries, p.q_proj);
  const k = linear(memory, keys, p.k_proj);
  const v = linear(memory, keys, p.v_proj);
  const scale = 1 / Math.sqrt(size); // single head
  const out = new Float32Array(queries * size);
  const scores = new Float64Array(keys);
  for (let i = 0; i < queries; i++) {
    let max = -Infinity;
    for (let j = 0; j < keys; j++) {
      if (causal && j > i) {
        scores[j] = -Infinity;
        continue;
      }
      let s = 0;
      for (let d = 0; d < size; d++) s += q[i * size + d] * k[j * size + d];
      s *= scale;
      scores[j] = s;
      if (s > max) max = s;
    }
    let z = 0;
    for (let j = 0; j < keys; j++) {
      scores[j] = Math.exp(scores[j] - max);
      z += scores[j];
    }
    for (let j = 0; j < keys; j++) {
      const a = scores[j] / z;
      if (a === 0) continue;
      for (let d = 0; d < size; d++) out[i * size + d] += a * v[j * size + d];
    }
  }
  return linear(out, queries, p.out_proj);
}

function feedForward(p: Layer, x: Float32Array, steps: number): Float32Array {
  const h = linear(x, steps, p.fc1);
  for (let i = 0; i < h.length; i++) h[i] = gelu(h[i]);
  return linear(h, steps, p.fc2);
}

function nest(tensors: Map<string, BartTensor>, prefix: string): any {
  const root: any = {};
  for (const [name, tensor] of tensors) {
    if (!name.startsWith(prefix)) continue;
    const parts = name.slice(prefix.length).split(".");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] ??= {};
    node[parts[parts.length - 1]] = tensor;
  }
  return root;
}

export class BartG2P {
  private readonly size: number;
  private readonly maxPositions: number;
  private readonly shared: BartTensor;
  private readonly logitsBias: BartTensor;
  private readonly encoder: Stack;
  private readonly decoder: Stack;
  private readonly graphemes: Map<string, number>;
  private readonly phonemes: string[];

  constructor(config: BartConfig, tensors: Map<string, BartTensor>) {
    for (const key of [
      "encoder_layers",
      "decoder_layers",
      "encoder_attention_heads",
      "decoder_attention_heads",
    ] as const)
      if ((config[key] ?? 1) !== 1)
        throw new Error(`unsupported BART config: ${key}`);
    if ((config.activation_function ?? "gelu") !== "gelu")
      throw new Error("unsupported BART activation");
    this.size = config.d_model;
    this.maxPositions = config.max_position_embeddings;
    const shared = tensors.get("model.shared.weight");
    const bias = tensors.get("final_logits_bias");
    if (!shared || !bias) throw new Error("BART weights are incomplete");
    this.shared = shared;
    this.logitsBias = bias;
    const encoder = nest(tensors, "model.encoder.");
    const decoder = nest(tensors, "model.decoder.");
    if (!encoder.layers?.[0] || !decoder.layers?.[0]?.encoder_attn)
      throw new Error("BART weights are incomplete");
    this.encoder = { ...encoder, layers: [encoder.layers[0]] };
    this.decoder = { ...decoder, layers: [decoder.layers[0]] };
    // The first four symbols are pad/bos/eos/unk placeholders.
    this.graphemes = new Map(
      [...config.grapheme_chars]
        .map((c, i) => [c, i] as [string, number])
        .filter(([, i]) => i > UNKNOWN),
    );
    this.phonemes = [...config.phoneme_chars];
  }

  private embed(ids: number[], positions: BartTensor): Float32Array {
    const size = this.size;
    const x = new Float32Array(ids.length * size);
    for (let t = 0; t < ids.length; t++)
      for (let d = 0; d < size; d++)
        x[t * size + d] =
          this.shared.data[ids[t] * size + d] +
          positions.data[(t + POSITION_OFFSET) * size + d];
    return x;
  }

  private encode(word: string): { memory: Float32Array; steps: number } {
    const ids = [
      BOS,
      ...[...word].map((c) => this.graphemes.get(c) ?? UNKNOWN),
      EOS,
    ];
    const { size } = this;
    const steps = ids.length;
    const layer = this.encoder.layers[0];
    let h = layerNorm(
      this.embed(ids, this.encoder.embed_positions.weight),
      steps,
      size,
      this.encoder.layernorm_embedding,
    );
    h = layerNorm(
      add(h, attention(layer.self_attn, h, steps, h, steps, size, false)),
      steps,
      size,
      layer.self_attn_layer_norm,
    );
    h = layerNorm(
      add(h, feedForward(layer, h, steps)),
      steps,
      size,
      layer.final_layer_norm,
    );
    return { memory: h, steps };
  }

  /** Phonemes for one word, or null when it is too long for the model. */
  predict(word: string, maxLength = 48): string | null {
    if (!word || word.length + 2 + POSITION_OFFSET > this.maxPositions)
      return null;
    const { memory, steps: memorySteps } = this.encode(word);
    const { size } = this;
    const layer = this.decoder.layers[0];
    const vocabulary = this.shared.shape[0];
    const out = [BOS];
    while (
      out.length < Math.min(maxLength, this.maxPositions - POSITION_OFFSET)
    ) {
      const steps = out.length;
      let h = layerNorm(
        this.embed(out, this.decoder.embed_positions.weight),
        steps,
        size,
        this.decoder.layernorm_embedding,
      );
      h = layerNorm(
        add(h, attention(layer.self_attn, h, steps, h, steps, size, true)),
        steps,
        size,
        layer.self_attn_layer_norm,
      );
      h = layerNorm(
        add(
          h,
          attention(
            layer.encoder_attn!,
            h,
            steps,
            memory,
            memorySteps,
            size,
            false,
          ),
        ),
        steps,
        size,
        layer.encoder_attn_layer_norm!,
      );
      h = layerNorm(
        add(h, feedForward(layer, h, steps)),
        steps,
        size,
        layer.final_layer_norm,
      );
      // Logits for the last position only: tied lm_head + final_logits_bias.
      const last = (steps - 1) * size;
      let best = EOS;
      let bestScore = -Infinity;
      for (let v = 0; v < vocabulary; v++) {
        let score = this.logitsBias.data[v];
        for (let d = 0; d < size; d++)
          score += this.shared.data[v * size + d] * h[last + d];
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      }
      if (best === EOS) break;
      out.push(best);
    }
    return out
      .slice(1)
      .filter((id) => id > UNKNOWN)
      .map((id) => this.phonemes[id] ?? "")
      .join("");
  }
}

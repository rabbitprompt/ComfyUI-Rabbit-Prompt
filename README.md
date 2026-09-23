# ComfyUI-Rabbit-Prompt

Generate prompts from your Rabbit projects directly inside ComfyUI.

## What it does

- Paste your Rabbit API key, click **Activate API Key**
- Pick one of your Rabbit projects
- Click **Generate Prompt** — the prompt is composed server-side from your project's blocks, connectors, weights and locks
- The output connects to any text input (a CLIP Text Encode node is created and connected automatically)
- Every queue run fetches a fresh prompt from your Rabbit project — reroll behavior is controlled in your Rabbit project, not in the node

## Get your API key

Log in to your Rabbit account → Settings → API → **Generate API Key**. Copy it — it is shown only once.

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/rabbitprompt/ComfyUI-Rabbit-Prompt.git
```

Then restart ComfyUI.

## Usage

1. Add the **Rabbit Prompt** node (double-click the canvas, type `rabbit`)
2. Paste your API key → **Activate API Key**
3. Select a project → **Generate Prompt**
4. Run your workflow

Your API key is stored locally in `config.json` and is never saved inside workflows.

## License

MIT

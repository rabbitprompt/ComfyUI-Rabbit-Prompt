import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

function errorMessage(data) {
  if (!data || !data.error) return "Unknown error";
  if (typeof data.error === "string") return data.error;
  return data.error.message || data.error.code || "Unknown error";
}

function promptUpdatedMessage() {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Prompt updated ✓ ${time}`;
}

function autoConnectClipTextEncode(node, wasConfiguring) {
  // don't spawn a duplicate node when loading a workflow or switching tabs;
  // wasConfiguring is captured at creation time because app.configuringGraph
  // is already back to false when the deferred call runs
  if (wasConfiguring) return;
  if (node.outputs?.[0]?.links?.length) return; // output already connected
  try {
    const clip = LiteGraph.createNode("CLIPTextEncode");
    if (!clip) return;
    clip.pos = [node.pos[0] + node.size[0] + 60, node.pos[1]];
    app.graph.add(clip);
    // reuse the existing "text" input if the frontend provides one (widget socket),
    // otherwise convert the text widget ourselves
    let inputIndex = clip.inputs.findIndex((i) => i.name === "text");
    if (inputIndex === -1) {
      const textWidget = (clip.widgets || []).find((w) => w.name === "text");
      if (!textWidget) return;
      clip.addInput("text", "STRING");
      textWidget.type = "converted-widget";
      textWidget.computeSize = () => [0, -4];
      inputIndex = clip.inputs.length - 1;
    }
    node.connect(0, clip, inputIndex);
  } catch (e) {
    console.warn("[Rabbit] could not auto-connect a CLIPTextEncode node:", e);
  }
}

// also write the generated text into the visible text widget of connected nodes
function mirrorTextToConnected(node, text) {
  const linkIds = node.outputs?.[0]?.links || [];
  for (const id of linkIds) {
    const link = node.graph?.links?.[id] ?? node.graph?.getLink?.(id);
    const target = link && app.graph.getNodeById(link.target_id);
    const w = target && (target.widgets || []).find((w) => w.name === "text");
    if (w) {
      w.value = text;
      w.callback?.(text);
      target.setDirtyCanvas(true, true);
    }
  }
}

app.registerExtension({
  name: "rabbit.prompt",

  async setup() {
    // after each Run with "New prompt on every run", the server sends back the
    // fresh prompt: show it in the node and in the connected CLIP
    api.addEventListener("executed", (e) => {
      const output = e.detail?.output;
      if (!output?.rabbit_prompt) return;
      const node = (app.graph._nodes || []).find((n) => String(n.id) === String(e.detail.node));
      if (!node || node.comfyClass !== "RabbitPrompt") return;
      const text = output.rabbit_prompt[0];
      const w = (node.widgets || []).find((w) => w.name === "prompt");
      if (w) w.value = text;
      mirrorTextToConnected(node, text);
      node._rabbitSetConfirm?.(promptUpdatedMessage());
      node.setDirtyCanvas(true, true);
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "RabbitPrompt") return;

    nodeType.prototype.onNodeCreated = function () {
      const node = this;
      const apiKeyWidget = node.widgets.find((w) => w.name === "api_key");
      const projectWidget = node.widgets.find((w) => w.name === "project");
      const newPromptWidget = node.widgets.find((w) => w.name === "new_prompt_on_run");
      if (newPromptWidget) newPromptWidget.label = "New prompt on every run";
      const promptWidget = node.widgets.find((w) => w.name === "prompt");

      // purple theme
      node.color = "#7c3aed";
      node.bgcolor = "#3b2a5e";

      // the key is NEVER saved inside workflows (it lives server-side in config.json)
      apiKeyWidget.serializeValue = () => "";
      // mask the key like a password (nicer when sharing your screen)
      if (apiKeyWidget.inputEl) {
        apiKeyWidget.inputEl.type = "password";
        apiKeyWidget.inputEl.autocomplete = "off";
      }

      const activateButton = node.addWidget("button", "Activate API Key", null, () => loadProjects(false));
      activateButton.serializeValue = () => undefined;

      const signupButton = node.addWidget("button", "Create an account on rabbitprompt.com", null, () => {
        window.open("https://www.rabbitprompt.com", "_blank");
      });
      signupButton.serializeValue = () => undefined;

      const relayout = () => {
        const s = node.computeSize();
        node.setSize([Math.max(s[0], 420), s[1]]);
        node.setDirtyCanvas(true, true);
      };

      // status line at the bottom of the node: orange for errors, grey for confirmations
      let statusText = "";
      let statusColor = "";
      const statusWidget = node.addCustomWidget({
        name: "status",
        type: "status",
        serializeValue: () => undefined,
        computeSize: () => [0, statusText ? 20 : 0],
        draw(ctx, node, width, y) {
          if (!statusText) return;
          ctx.fillStyle = statusColor;
          ctx.font = "12px sans-serif";
          ctx.fillText(statusText, 12, y + 15, width - 24);
        },
      });
      const setStatus = (msg, color) => {
        statusText = msg || "";
        statusColor = color;
        relayout();
      };
      const setError = (msg) => setStatus(msg, "#fb923c");
      const setConfirm = (msg) => setStatus(msg, "rgba(255, 255, 255, 0.45)");
      node._rabbitSetConfirm = setConfirm; // used by the executed listener after a Run

      // these buttons only matter when no key is stored, or to change key
      const showActivate = () => {
        if (node.widgets.includes(activateButton)) return;
        node.widgets.splice(1, 0, activateButton, signupButton);
        relayout();
      };
      const hideActivate = () => {
        for (const w of [activateButton, signupButton]) {
          const i = node.widgets.indexOf(w);
          if (i !== -1) node.widgets.splice(i, 1);
        }
        relayout();
      };

      // typing a key brings the button back so the new key can be activated
      const origKeyCallback = apiKeyWidget.callback;
      apiKeyWidget.callback = (...args) => {
        origKeyCallback?.(...args);
        if (apiKeyWidget.value.trim()) showActivate();
      };

      // shared by the button (shows errors) and the auto-load on node creation (silent)
      const loadProjects = async (silent) => {
        if (!silent) setError("");
        try {
          const res = await api.fetchApi("/rabbit/projects", {
            method: "POST",
            body: JSON.stringify({ api_key: apiKeyWidget.value.trim() }),
          });
          const data = await res.json();
          if (!res.ok) {
            showActivate(); // no usable key: the button must be reachable
            if (!silent) setError(errorMessage(data));
            return;
          }
          if (!data.projects?.length) {
            if (!silent) setError("No project found on this rabbit account.");
            return;
          }
          const names = data.projects.map((p) => p.name);
          projectWidget.options.values = names;
          // keep the restored selection when loading a workflow, pick the first project otherwise
          if (!names.includes(projectWidget.value)) projectWidget.value = names[0];
          apiKeyWidget.value = ""; // key is now stored server-side, clear the field
          hideActivate();
          setError("");
        } catch (e) {
          if (!silent) setError("Network error: " + e);
        }
      };

      // projects load themselves using the stored key (no key in the field needed)
      loadProjects(true);

      const divider = node.addCustomWidget({
        name: "divider",
        type: "divider",
        serializeValue: () => undefined,
        computeSize: () => [0, 14],
        draw(ctx, node, width, y) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
          ctx.beginPath();
          ctx.moveTo(12, y + 7);
          ctx.lineTo(width - 12, y + 7);
          ctx.stroke();
        },
      });

      const generateButton = node.addWidget("button", "Generate new prompt", null, async () => {
        if (generateButton.disabled) return; // already generating
        const val = projectWidget.value || "";
        if (!val || val.startsWith("(")) return setError("Activate your API key and pick a project first.");
        generateButton.name = "Generating...";
        generateButton.disabled = true;
        setError("");
        try {
          const res = await api.fetchApi("/rabbit/generate", {
            method: "POST",
            body: JSON.stringify({ api_key: apiKeyWidget.value.trim(), project: val }),
          });
          const data = await res.json();
          if (!res.ok) return setError(errorMessage(data));
          promptWidget.value = data.text;
          mirrorTextToConnected(node, data.text);
          setConfirm(promptUpdatedMessage());
        } catch (e) {
          setError("Network error: " + e);
        } finally {
          generateButton.name = "Generate new prompt";
          generateButton.disabled = false;
          node.setDirtyCanvas(true, true);
        }
      });
      generateButton.serializeValue = () => undefined;

      // taller prompt area
      const baseComputeSize = promptWidget.computeSize;
      promptWidget.computeSize = function (width) {
        const size = baseComputeSize ? baseComputeSize.call(this, width) : [width, 20];
        size[1] = Math.max(size[1], 220);
        return size;
      };

      const copyButton = node.addWidget("button", "Copy prompt", null, async () => {
        const text = promptWidget.value || "";
        if (!text) return setError("Nothing to copy yet.");
        try {
          await navigator.clipboard.writeText(text);
          setError("");
        } catch (e) {
          setError("Could not copy: " + e);
        }
      });
      copyButton.serializeValue = () => undefined;

      // layout: api_key, activate, signup, divider, project, new prompt toggle, prompt, copy, generate, status line
      node.widgets = [apiKeyWidget, activateButton, signupButton, divider, projectWidget, newPromptWidget, promptWidget, copyButton, generateButton, statusWidget].filter(Boolean);
      const size = node.computeSize();
      node.setSize([Math.max(size[0], 420), size[1]]);

      // defer: during onNodeCreated the node is not in the graph yet, so connect()
      // would fail and pos/size would be stale. Next frame everything is in place.
      const wasConfiguring = !!app.configuringGraph;
      requestAnimationFrame(() => autoConnectClipTextEncode(node, wasConfiguring));
    };
  },
});

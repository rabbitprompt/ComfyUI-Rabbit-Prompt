import json
import os
import time
import urllib.error
import urllib.request

import aiohttp
from aiohttp import web
from server import PromptServer

API_BASE = "https://us-central1-rabbit-46dfd.cloudfunctions.net"
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")


def load_config():
    try:
        with open(CONFIG_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    try:
        with open(CONFIG_PATH, "w") as f:
            json.dump(cfg, f)
    except Exception as e:
        print(f"[Rabbit] could not write config.json: {e}")


def get_api_key(payload):
    key = (payload or {}).get("api_key", "").strip()
    if key:
        cfg = load_config()
        cfg["api_key"] = key
        save_config(cfg)
        return key
    return load_config().get("api_key", "")


async def call_rabbit(path, api_key, method="GET", body=None):
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.request(method, url=API_BASE + path, headers=headers, json=body) as resp:
            data = await resp.json(content_type=None)
            return resp.status, data


def call_rabbit_sync(path, api_key, body=None):
    # used from node execution, which already runs inside an event loop: no asyncio here
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"x-api-key": api_key, "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": str(e)}


@PromptServer.instance.routes.post("/rabbit/projects")
async def rabbit_projects(request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    api_key = get_api_key(payload)
    if not api_key:
        return web.json_response({"error": "No API key. Paste your sk_... key in the node."}, status=401)
    try:
        status, data = await call_rabbit("/apiGetProjects", api_key)
    except Exception as e:
        return web.json_response({"error": f"Could not reach rabbit: {e}"}, status=502)
    # remember the project list so INPUT_TYPES can offer it (prompt validation
    # rejects any combo value that is not in the Python-side list) and so the
    # project id can be resolved from the displayed name
    if status == 200 and isinstance(data, dict) and data.get("projects"):
        cfg = load_config()
        cfg["projects"] = [{"name": p.get("name"), "id": p.get("id")} for p in data["projects"]]
        save_config(cfg)
    return web.json_response(data, status=status)


def resolve_project_id(project):
    for p in load_config().get("projects", []):
        if isinstance(p, dict) and p.get("name") == project:
            return p.get("id")
        if isinstance(p, str) and p == project and " · " in p:  # legacy "name · id" entries
            return p.split(" · ")[-1].strip()
    return None


@PromptServer.instance.routes.post("/rabbit/generate")
async def rabbit_generate(request):
    payload = await request.json()
    api_key = get_api_key(payload)
    if not api_key:
        return web.json_response({"error": "No API key. Paste your sk_... key in the node."}, status=401)
    project_id = resolve_project_id((payload.get("project") or "").strip())
    if not project_id:
        return web.json_response({"error": "No project selected."}, status=400)
    try:
        status, data = await call_rabbit("/apiGenerate", api_key, method="POST", body={"projectId": project_id})
    except Exception as e:
        return web.json_response({"error": f"Could not reach rabbit: {e}"}, status=502)
    return web.json_response(data, status=status)


class RabbitPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        stored = load_config().get("projects") or []
        projects = [p["name"] if isinstance(p, dict) else p for p in stored] or ["(activate your API key first)"]
        return {"required": {
            "api_key": ("STRING", {"default": "", "placeholder": "sk_... (remembered after first use)"}),
            "project": (projects,),
            "new_prompt_on_run": ("BOOLEAN", {"default": True}),
            "prompt": ("STRING", {"multiline": True, "default": "", "placeholder": "Your generated prompt will appear here"}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("CLIP Text Encode",)
    FUNCTION = "run"
    CATEGORY = "rabbit"
    DESCRIPTION = "Generate a prompt from your Rabbit project."

    @classmethod
    def IS_CHANGED(cls, api_key, project, new_prompt_on_run, prompt):
        # ComfyUI skips nodes whose inputs did not change; with the toggle on we
        # must run every time to fetch a fresh prompt
        if not new_prompt_on_run:
            return False
        return time.time()

    def run(self, api_key, project, new_prompt_on_run, prompt):
        if not new_prompt_on_run:
            return (prompt,)
        key = get_api_key({"api_key": api_key})
        if not key:
            raise ValueError("No API key. Paste your sk_... key in the node and activate it.")
        project_id = resolve_project_id(project)
        if not project_id:
            raise ValueError("No project selected. Activate your API key and pick a project.")
        try:
            status, data = call_rabbit_sync("/apiGenerate", key, body={"projectId": project_id})
        except Exception as e:
            raise RuntimeError(f"Could not reach rabbit: {e}")
        if status != 200:
            error = data.get("error", data) if isinstance(data, dict) else data
            raise RuntimeError(f"rabbit generate failed ({status}): {error}")
        text = data.get("text")
        if not text:
            raise RuntimeError(f"rabbit generate returned no text: {data}")
        # ui payload lets the frontend display the freshly generated prompt
        return {"ui": {"rabbit_prompt": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {"RabbitPrompt": RabbitPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"RabbitPrompt": "Rabbit Prompt"}
WEB_DIRECTORY = "./web"

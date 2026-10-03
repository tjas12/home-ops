const chunkFiles = [
  "./app.bundle.001.b64",
  "./app.bundle.002.b64",
  "./app.bundle.003.b64",
  "./app.bundle.004.b64",
  "./app.bundle.005.b64",
  "./app.bundle.006.b64",
  "./app.bundle.007.b64",
  "./app.bundle.008.b64",
  "./app.bundle.009.b64",
  "./app.bundle.010.b64",
];

async function loadHomeOpsApp() {
  const chunks = await Promise.all(
    chunkFiles.map(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`Unable to load ${path}`);
      return response.text();
    })
  );
  const base64 = chunks.join("").replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const moduleUrl = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  await import(moduleUrl);
}

loadHomeOpsApp().catch((error) => {
  console.error("[Home Ops] App failed to load.", error);
  const message = document.querySelector("#auth-message");
  if (message) message.textContent = "Home Ops could not load. Please refresh and try again.";
});

import { chromium } from "playwright";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const baseURL = process.env.BASE_URL || "http://127.0.0.1:8080";
let recoveryInviteURL = "";

const browser = await chromium.launch({ headless: true });

try {
  await runFullLinkSmoke();
  await runSSERecoverySmoke();
  await runCodeSmoke();
  await runMultiRoomIsolationSmoke();
} finally {
  await browser.close();
}

async function runMultiRoomIsolationSmoke() {
  const context = await browser.newContext();
  try {
    const firstRoom = await context.newPage();
    const secondRoom = await context.newPage();
    await firstRoom.goto(baseURL, { waitUntil: "domcontentloaded" });
    await firstRoom.getByRole("button", { name: "创建大力房间" }).click();
    await firstRoom.waitForURL(/\/r\/.+#k=.+/, { timeout: 10000 });
    await enterName(firstRoom, "First tab");
    await secondRoom.goto(baseURL, { waitUntil: "domcontentloaded" });
    await secondRoom.getByRole("button", { name: "创建大力房间" }).click();
    await secondRoom.waitForURL(/\/r\/.+#k=.+/, { timeout: 10000 });
    await enterName(secondRoom, "Second tab");
    await firstRoom.getByText("已连接").waitFor({ timeout: 10000 });
    await secondRoom.getByText("已连接").waitFor({ timeout: 10000 });
    await firstRoom.getByPlaceholder("输入消息").fill("first-room-only");
    await firstRoom.getByRole("button", { name: "发送群聊" }).click();
    await firstRoom.getByText("first-room-only").waitFor({ timeout: 10000 });
    await secondRoom.waitForTimeout(500);
    if (await secondRoom.getByText("first-room-only").count()) {
      throw new Error("message leaked between rooms in separate tabs");
    }
    const [firstDevice, secondDevice] = await Promise.all([
      firstRoom.locator(".meta-pill").filter({ hasText: "设备" }).locator("strong").textContent(),
      secondRoom.locator(".meta-pill").filter({ hasText: "设备" }).locator("strong").textContent(),
    ]);
    if (!firstDevice || !secondDevice || firstDevice === secondDevice) {
      throw new Error(`expected tab-isolated device IDs, got ${firstDevice} and ${secondDevice}`);
    }
    console.log(JSON.stringify({ mode: "multi-room-tabs", firstDevice, secondDevice }, null, 2));
  } finally {
    await context.close();
  }
}

async function runFullLinkSmoke() {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    await pageA.goto(baseURL, { waitUntil: "domcontentloaded" });
    await pageA.getByRole("button", { name: "创建大力房间" }).click();
    await pageA.waitForURL(/\/r\/.+#k=.+/, { timeout: 10000 });
    await enterName(pageA, "Alice");
    const inviteURL = pageA.url();
    recoveryInviteURL = inviteURL;

    const pageB = await contextB.newPage();
    await pageB.goto(inviteURL, { waitUntil: "domcontentloaded" });
    await enterName(pageB, "Bob");

    const pageC = await contextC.newPage();
    await pageC.goto(inviteURL, { waitUntil: "domcontentloaded" });
    await enterName(pageC, "Charlie");

    await assertChatWorks(pageA, pageB, pageC);

    const result = {
      mode: "full-link",
      inviteURL,
      pageAMessages: await pageA.locator(".message").allTextContents(),
      pageBMessages: await pageB.locator(".message").allTextContents(),
      pageCMessages: await pageC.locator(".message").allTextContents(),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await contextA.close();
    await contextB.close();
    await contextC.close();
  }
}

async function runSSERecoverySmoke() {
  const fallbackContext = await browser.newContext();
  const peerContext = await browser.newContext();
  try {
    await fallbackContext.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      let failuresRemaining = 1;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          if (failuresRemaining <= 0) return new Target(...args);
          failuresRemaining -= 1;
          class FailedSocket extends EventTarget {
            constructor() {
              super();
              this.readyState = NativeWebSocket.CONNECTING;
              this.bufferedAmount = 0;
              queueMicrotask(() => {
                this.dispatchEvent(new Event("error"));
                this.readyState = NativeWebSocket.CLOSED;
                this.dispatchEvent(new CloseEvent("close"));
              });
            }
            close() {
              this.readyState = NativeWebSocket.CLOSED;
            }
            send() {
              throw new Error("simulated WebSocket failure");
            }
          }
          return new FailedSocket();
        },
      });
    });

    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.goto(recoveryInviteURL, { waitUntil: "domcontentloaded" });
    await enterName(fallbackPage, "SSE fallback");
    await fallbackPage.getByText("已连接（兼容模式）", { exact: true }).waitFor({ timeout: 10000 });
    await fallbackPage.getByPlaceholder("输入消息").fill("sent while using SSE");
    await fallbackPage.getByRole("button", { name: "发送群聊" }).click();
    await fallbackPage.getByText("已连接", { exact: true }).waitFor({ timeout: 10000 });

    const peerPage = await peerContext.newPage();
    await peerPage.goto(recoveryInviteURL, { waitUntil: "domcontentloaded" });
    await enterName(peerPage, "WS peer");
    await peerPage.getByText("已连接", { exact: true }).waitFor({ timeout: 10000 });
    await peerPage.getByPlaceholder("输入消息").fill("after websocket recovery");
    await peerPage.getByRole("button", { name: "发送群聊" }).click();
    await fallbackPage.getByText("after websocket recovery").waitFor({ timeout: 10000 });
    console.log(JSON.stringify({ mode: "sse-websocket-recovery" }, null, 2));
  } finally {
    await fallbackContext.close();
    await peerContext.close();
  }
}

async function runCodeSmoke() {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    await pageA.goto(baseURL, { waitUntil: "domcontentloaded" });
    await pageA.getByRole("button", { name: "创建随机码房间" }).click();
    await pageA.waitForURL(/\/r\/[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4,32}#p=[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4,32}/, { timeout: 30000 });
    await enterName(pageA, "Alice");
    const inviteURL = pageA.url();
    const code = new URL(inviteURL).pathname.split("/").pop();

    const pageB = await contextB.newPage();
    await pageB.goto(baseURL, { waitUntil: "domcontentloaded" });
    await pageB.getByPlaceholder("输入群聊码").fill(code);
    await pageB.getByRole("button", { name: "用群聊码加入" }).click();
    await pageB.waitForURL(new RegExp(`/r/${code}#p=${code}`), { timeout: 30000 });
    await enterName(pageB, "Bob");

    const pageC = await contextC.newPage();
    await pageC.goto(inviteURL, { waitUntil: "domcontentloaded" });
    await enterName(pageC, "Charlie");

    await assertChatWorks(pageA, pageB, pageC);

    const result = {
      mode: "code",
      code,
      inviteURL,
      pageAMessages: await pageA.locator(".message").allTextContents(),
      pageBMessages: await pageB.locator(".message").allTextContents(),
      pageCMessages: await pageC.locator(".message").allTextContents(),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await contextA.close();
    await contextB.close();
    await contextC.close();
  }
}

async function assertChatWorks(pageA, pageB, pageC) {
  await pageA.getByText("已连接").waitFor({ timeout: 10000 });
  await pageB.getByText("已连接").waitFor({ timeout: 10000 });
  await pageC.getByText("已连接").waitFor({ timeout: 10000 });

  await pageA.locator(".members .n-list-item").filter({ hasText: "私发唯一码" }).first().waitFor({ timeout: 10000 });
  await pageB.locator(".members .n-list-item").filter({ hasText: "私发唯一码" }).first().waitFor({ timeout: 10000 });
  await pageC.locator(".members .n-list-item").filter({ hasText: "私发唯一码" }).first().waitFor({ timeout: 10000 });
  await pageA.locator(".members .avatar").nth(2).waitFor({ timeout: 10000 });
  await pageB.locator(".members .avatar").nth(2).waitFor({ timeout: 10000 });
  await pageC.locator(".members .avatar").nth(2).waitFor({ timeout: 10000 });

  await pageA.getByPlaceholder("输入消息").fill("hello from A group");
  await pageA.getByRole("button", { name: "发送群聊" }).click();
  await pageB.getByText("hello from A group").waitFor({ timeout: 10000 });
  await pageC.getByText("hello from A group").waitFor({ timeout: 10000 });

  await pageA.getByRole("button", { name: "切换代码模式" }).click();
  await pageA.getByPlaceholder("输入消息").fill("const answer = 42;");
  await pageA.getByRole("button", { name: "发送群聊" }).click();
  await pageB.locator(".code-block").filter({ hasText: "const answer = 42;" }).waitFor({ timeout: 10000 });

  await pageA.locator('input[type="file"]').setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("encrypted file from A"),
  });
  await pageA.getByRole("button", { name: "发送群聊" }).click();
  await pageB.getByText("hello.txt").waitFor({ timeout: 10000 });

  await pageB.getByPlaceholder("输入消息").fill("hello from B group");
  await pageB.getByRole("button", { name: "发送群聊" }).click();
  await pageA.getByText("hello from B group").waitFor({ timeout: 10000 });
  await pageC.getByText("hello from B group").waitFor({ timeout: 10000 });
  await pageB.getByPlaceholder("输入消息").fill("first line\nsecond line\nthird line");
  await pageB.getByRole("button", { name: "发送群聊" }).click();
  const multiline = pageA.locator(".message-bubble .text").filter({ hasText: "first line" });
  await multiline.waitFor({ timeout: 10000 });
  if (await multiline.innerText() !== "first line\nsecond line\nthird line") {
    throw new Error("plain-text message line breaks were not preserved");
  }
  await assertDifferentSenderColors(pageC, "hello from A group", "hello from B group");

  await pageB.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await pageB.getByRole("button", { name: "发送群聊" }).click();
  await pageA.getByText("pixel.png").waitFor({ timeout: 10000 });

  await pageA.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const file = new File([bytes], "paste.png", { type: "image/png" });
    const item = new DataTransfer();
    item.items.add(file);
    const input = document.querySelector('textarea[placeholder="输入消息"], input[placeholder="输入消息"]');
    input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: item,
    }));
  }, tinyPng.toString("base64"));
  await pageA.getByText(/pasted-image-|paste\\.png/).waitFor({ timeout: 10000 });
  await pageA.getByRole("button", { name: "发送群聊" }).click();
  await pageB.getByText(/pasted-image-|paste\\.png/).waitFor({ timeout: 10000 });

  await pageA.locator(".attachment-image").first().click();
  await pageA.locator(".image-preview-card").waitFor({ timeout: 10000 });
  await pageA.getByRole("button", { name: "放大图片" }).click();
  await pageA.getByText("125%", { exact: true }).waitFor({ timeout: 10000 });
  const zoomedTransform = await pageA.locator(".image-preview-stage img").getAttribute("style");
  if (!zoomedTransform?.includes("scale(1.25)")) {
    throw new Error(`image preview did not zoom: ${zoomedTransform}`);
  }
  await pageA.getByRole("button", { name: "重置" }).click();
  await pageA.getByText("100%", { exact: true }).waitFor({ timeout: 10000 });
  await pageA.getByRole("button", { name: "关闭", exact: true }).click();

  await pageA.locator(".members .n-list-item").filter({ hasText: "Bob" }).click();
  await pageA.getByPlaceholder("输入消息").fill("private from A to B");
  await pageA.getByRole("button", { name: /^私发给 / }).click();
  await pageB.getByText("private from A to B").waitFor({ timeout: 10000 });
  await pageC.waitForTimeout(500);
  if (await pageC.getByText("private from A to B").count()) {
    throw new Error("third client should not see private message content");
  }
  if (await pageC.getByText(/不可读私信|private/i).count()) {
    throw new Error("third client should not see private-message system hints");
  }

  await pageA.getByRole("button", { name: "一键鸵鸟" }).click();
  await pageA.getByRole("button", { name: "确认", exact: true }).click();
  await pageB.getByText("hello from A group").waitFor({ state: "detached", timeout: 10000 });
  await pageC.getByText("hello from A group").waitFor({ state: "detached", timeout: 10000 });
  await pageB.getByText("hello from B group").waitFor({ timeout: 10000 });
}

async function assertDifferentSenderColors(page, firstText, secondText) {
  const colors = await page.evaluate(({ firstText, secondText }) => {
    function messageColor(text) {
      const messages = [...document.querySelectorAll(".message")];
      const message = messages.find((node) => node.textContent.includes(text));
      return message ? getComputedStyle(message).getPropertyValue("--user-color").trim() : "";
    }
    return [messageColor(firstText), messageColor(secondText)];
  }, { firstText, secondText });
  if (!colors[0] || !colors[1] || colors[0] === colors[1]) {
    throw new Error(`expected different sender colors, got ${colors.join(", ")}`);
  }
}

async function enterName(page, name) {
  await page.getByPlaceholder("给自己起个名字").fill(name);
  await page.getByRole("button", { name: "进入聊天" }).click();
}

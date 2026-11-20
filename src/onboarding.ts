import { useEffect, useState } from "react";
import { Host, Settings } from "./api";

/** 上手清单和就地提示用到的本地标记 */
export const GUIDE_HIDDEN = "ccws.guideHidden";
/** 环境检查通过过的主机 id */
export const ENV_OK = "ccws.onboard.envOk";
/** 在 Claude 注册页成功注册过 */
export const MCP_REGISTERED = "ccws.onboard.mcpRegistered";
/** 主机 MCP 弹窗顶部的说明已关掉 */
export const MCP_TIP_HIDDEN = "ccws.tip.mcpDialog";

const EVENT = "ccws-onboard";

export function getFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 写标记并通知清单刷新（标记可能在弹窗里写，清单在启动台显示） */
export function setFlag(key: string, value = "1") {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不下只是下次还会提示
  }
  window.dispatchEvent(new Event(EVENT));
}

export interface Step {
  key: "host" | "env" | "open" | "files" | "cmd";
  title: string;
  hint: string;
  done: boolean;
  optional?: boolean;
}

/** 上手清单：前三步必做，后两步可选；完成状态都自动判断 */
export function useOnboarding(hosts: Host[], hasOpened: boolean, settings: Settings | null) {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  const envOk = getFlag(ENV_OK);
  const steps: Step[] = [
    { key: "host", title: "添加一台云主机", hint: "填 SSH 地址和登录方式，或从 ~/.ssh/config 导入已有的主机", done: hosts.length > 0 },
    {
      key: "env",
      title: "检查云主机环境",
      hint: "确认云主机装了 Claude Code 并登录过；缺什么这里会给出命令",
      done: !!envOk && hosts.some((h) => h.id === envOk),
    },
    { key: "open", title: "开始第一次对话", hint: "对话：图形界面和云端 Claude Code 协作；终端：像 SSH 一样操作云主机", done: hasOpened },
    {
      key: "files",
      title: "让云端 Claude 用本机文件",
      hint: "工具箱里选允许的目录 → 主机「MCP 转发」里转发并注册到 Claude，新开的对话就能读写本机项目",
      done: !!getFlag(MCP_REGISTERED),
      optional: true,
    },
    {
      key: "cmd",
      title: "设置命令执行模式",
      hint: "默认关闭。想让云端 Claude 在本机跑构建、测试，推荐「白名单 + 确认」",
      done: !!settings && settings.commandMode !== "off",
      optional: true,
    },
  ];
  const required = steps.filter((s) => !s.optional);
  return {
    steps,
    done: required.filter((s) => s.done).length,
    total: required.length,
    hidden: getFlag(GUIDE_HIDDEN) === "1",
  };
}

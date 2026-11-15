"use client";

import { createContext, useContext } from "react";

/** What a card in the conversation can do to the conversation: say something to the agent (e.g. "it's approved"). */
export type ChatActions = { say: (text: string) => void };
export const ChatActionsContext = createContext<ChatActions>({ say: () => {} });
export const useChatActions = () => useContext(ChatActionsContext);

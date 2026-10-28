/** Canaries planted in tests/fixtures/synthetic/prompt-facts*.jsonl. None may reach any parser output. */
export const FACT_CANARIES = [
  "CANARY_PROMPT_STR_1f4a",
  "CANARY_PROMPT_BLK_2b7c",
  "CANARY_PROMPT_BLK_3c8d",
  "CANARY_RESULT_FACT_4d9e",
  "CANARY_PROMPT_MIX_5e0f",
  "CANARY_IMAGE_6f1a",
  "CANARY_PROMPT_MIXRES_7a2b",
  "CANARY_RESULT_FACT_8b3c",
  "CANARY_PROMPT_OBJ_9c4d",
  "CANARY_PROMPT_DEEP_ad5e",
  "CANARY_PROMPT_NEST_be6f",
  "CANARY_PROMPT_ARR_c07a",
  "CANARY_PROMPT_BARE_d18b",
  "CANARY_PROMPT_SIDE_e29c",
  "CANARY_RESPONSE_FACT_f3ad",
  "CANARY_PATH_FACT_04be",
  "CANARY_MCP_15cf",
  "CANARY_ARGS_26d0",
  "CANARY_TOOL_37e1",
  "CANARY_CMD_FACT_48f2",
  "CANARY_PROMPT_SRCB_5903",
] as const;

export const PROMPT_FACTS_A = "prompt-facts.jsonl";
export const PROMPT_FACTS_B = "prompt-facts-b.jsonl";

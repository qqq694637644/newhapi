export interface CodexModelOption {
    value: string
    label: string
    description: string
}

export const CODEX_MODEL_OPTIONS: CodexModelOption[] = [
    {
        value: 'gpt-5.2-codex',
        label: 'GPT-5.2 Codex (Default)',
        description: 'Frontier agentic coding model.'
    },
    {
        value: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex (Current)',
        description: 'Latest frontier agentic coding model.'
    },
    {
        value: 'gpt-5.1-codex-max',
        label: 'GPT-5.1 Codex Max',
        description: 'Codex-optimized flagship for deep and fast reasoning.'
    },
    {
        value: 'gpt-5.2',
        label: 'GPT-5.2',
        description: 'Latest frontier model with improvements across knowledge, reasoning and coding.'
    },
    {
        value: 'gpt-5.1-codex-mini',
        label: 'GPT-5.1 Codex Mini',
        description: 'Optimized for Codex. Cheaper, faster, but less capable.'
    },
]

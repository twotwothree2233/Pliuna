export interface ModelChannel {
  id: string
  name: string
  base_url: string
  compatibility_profile: 'chat-max-tokens' | 'chat-max-completion-tokens'
}
export interface SavedChannel extends ModelChannel { key: string | null; revision: number }
export interface ChannelEntry extends SavedChannel { remembered: boolean }

export type HotdealPost = {
  title: string;
  link: string;
  id: string;
  publishedAt?: string;
};

export type AlertPayload = {
  matchedKeywords: string[];
  message: string;
};

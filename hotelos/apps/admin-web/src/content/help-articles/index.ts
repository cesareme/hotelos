export interface HelpArticle {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly summary: string;
  readonly body: readonly string[];
  readonly relatedScreens?: readonly string[];
  readonly tags?: readonly string[];
}

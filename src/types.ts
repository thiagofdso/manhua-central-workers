export interface ChapterExtractionRequest {
  url: string;
  domain: string;
  chapter: number;
}

export interface ChapterImageResult {
  index: number;
  url: string;
}

export interface ChapterExtractionResult {
  success: boolean;
  domain: string;
  chapter: number;
  images: ChapterImageResult[];
  totalImages: number;
  nextChapter?: string;
  prevChapter?: string;
  error?: string;
}

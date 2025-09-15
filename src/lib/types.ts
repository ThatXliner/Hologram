export interface Photo {
	id: string;
	file_path: string;
	file_name: string;
	file_size: number;
	file_type: string;
	thumbnail?: string; // base64 encoded thumbnail
	exif: ExifData;
	created_at: string;
	modified_at: string;
	paired_with?: string; // ID of paired RAW/JPEG
}

export interface ExifData {
	camera_make?: string;
	camera_model?: string;
	lens_model?: string;
	focal_length?: number;
	aperture?: number;
	shutter_speed?: string;
	iso?: number;
	exposure_mode?: string;
	flash?: string;
	white_balance?: string;
	date_taken?: string;
	width?: number;
	height?: number;
	orientation?: number;
}

export interface PhotoFilter {
	camera_make?: string;
	camera_model?: string;
	lens_model?: string;
	focal_length_range?: [number, number];
	aperture_range?: [number, number];
	iso_range?: [number, number];
	date_range?: [string, string];
	file_type?: string;
}

export interface PhotoStats {
	total_photos: number;
	raw_count: number;
	jpeg_count: number;
	paired_count: number;
	cameras: Record<string, number>;
	lenses: Record<string, number>;
}

export interface AppState {
	photos: Photo[];
	filteredPhotos: Photo[];
	selectedPhoto?: Photo;
	currentFilter: PhotoFilter;
	isLoading: boolean;
	stats?: PhotoStats;
	viewMode: 'grid' | 'list' | 'viewer';
}
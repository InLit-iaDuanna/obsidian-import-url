import {JobStatus, SourceType} from "../types";

export interface FrontmatterInput {
	sourceUrl: string;
	sourceType: SourceType;
	sourceTitle: string;
	status: JobStatus;
	title: string;
	clippedAt: string;
	model: string;
	language: string;
	tags: string[];
}

function quoteYaml(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function renderFrontmatter(input: FrontmatterInput): string {
	const lines = [
		"---",
		`source_url: ${quoteYaml(input.sourceUrl)}`,
		`source_type: ${quoteYaml(input.sourceType)}`,
		`source_title: ${quoteYaml(input.sourceTitle)}`,
		`status: ${quoteYaml(input.status)}`,
		`title: ${quoteYaml(input.title)}`,
		`clipped_at: ${quoteYaml(input.clippedAt)}`,
		`model: ${quoteYaml(input.model)}`,
		`language: ${quoteYaml(input.language)}`,
	];

	if (input.tags.length === 0) {
		lines.push("tags: []");
	} else {
		lines.push("tags:");
		for (const tag of input.tags) {
			lines.push(`  - ${quoteYaml(tag)}`);
		}
	}

	lines.push("---");
	return lines.join("\n");
}

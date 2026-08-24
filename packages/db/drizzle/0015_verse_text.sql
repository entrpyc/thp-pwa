CREATE TABLE "verse_text" (
	"translation" text NOT NULL,
	"book" text NOT NULL,
	"chapter" integer NOT NULL,
	"verse" integer NOT NULL,
	"text" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verse_text_passage_pk" PRIMARY KEY("translation","book","chapter","verse")
);

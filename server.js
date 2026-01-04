import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("AI preview is live");
});

app.listen(process.env.PORT || 8080);

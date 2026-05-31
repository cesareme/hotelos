# Spain Guest Register and SES.HOSPEDAJES Compliance

HotelOS implements the Spain guest register module as an incremental compliance layer:

- Module code: `spain_guest_register_compliance`.
- Authority routing defaults to `ses_hospedajes`, with configurable placeholders for `mossos`, `ertzaintza`, `manual` and `other`.
- Temporary document scans are allowed only for OCR/MRZ extraction.
- Raw DNI/passport/TIE images are discarded immediately and logged as `ID_IMAGE_DISCARDED`.
- Guest register records retain only required legal fields and authority receipts for three years from end of service.
- Children under 14 are linked to an accompanying adult provider and do not require signature.
- Guests older than 14 must sign the parte de entrada before submission.
- Manual daily batch export and queued web-service submission use the same audit trail.

The exact official SES.HOSPEDAJES XML/TXT/API schema is not hardcoded. Hotels must load the official schema/template/service-web documentation through Back Office before production submission is enabled.
